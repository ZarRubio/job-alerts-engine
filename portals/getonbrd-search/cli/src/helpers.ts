// Data source: Get on Board's public REST API v0 (JSON:API-style `{data, meta}`
// envelope). The public facet - categories, companies, published jobs and the
// job search endpoint - needs no authentication, and robots.txt allows /api/.
// No markup to parse: we fetch JSON and reshape it into the portal-skill
// contract's result fields.

export const BASE_URL = "https://www.getonbrd.com"

// Honest User-Agent naming the tool, the convention every portal CLI follows.
const UA = "Mozilla/5.0 (compatible; getonbrd-cli/1.0)"

// The related resources each search/company-jobs call expands inline, so one
// request yields company name, city names and seniority instead of bare ids.
export const EXPAND = '["company","location_cities","location_tenants","location_regions","seniority"]'

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

// The most apiGet sleeps across all retries of one request, so an outage
// degrades this source quickly instead of outlasting the caller's timeout.
const RETRY_BUDGET_MS = 30_000

/** The wait a 429/503 asks for via `Retry-After`, in ms, or null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null
  const value = header.trim()
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const date = Date.parse(value)
  if (Number.isNaN(date)) return null
  return Math.max(date - now, 0)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * GET a JSON document from the Get on Board API. Retries 429/5xx with
 * exponential backoff plus jitter (honouring Retry-After within a budget);
 * returns `null` on a 404. A connection failure fails fast with a clear message.
 * Any other 4xx surfaces the API's own `message` (e.g. the 422 it answers when
 * country_code and remote are combined).
 */
export async function apiGet<T>(path: string): Promise<T | null> {
  const url = `${BASE_URL}${path}`
  const maxRetries = 6
  let delay = 500
  let waited = 0

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      })
    } catch (e) {
      throw new Error(`could not reach the Get on Board API (${e instanceof Error ? e.message : String(e)})`)
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`Get on Board API request failed: ${response.status} ${response.statusText}`)
      }
      const backoff = delay + Math.floor(Math.random() * 500)
      const wait = Math.max(backoff, retryAfterMs(response.headers.get("Retry-After")) ?? 0)
      if (waited + wait > RETRY_BUDGET_MS) {
        throw new Error(
          `Get on Board API request failed: ${response.status}; the server asked to retry in ` +
            `${Math.ceil(wait / 1000)}s, past this CLI's ${RETRY_BUDGET_MS / 1000}s retry budget`,
        )
      }
      await sleep(wait)
      waited += wait
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return null

    const body = (await response.json().catch(() => null)) as (T & { message?: string }) | null
    if (!response.ok) {
      throw new Error(body?.message || `Get on Board API request failed: ${response.status} ${response.statusText}`)
    }
    if (!body) throw new Error("Get on Board API returned an unparseable response body")
    return body
  }
  throw new Error("Get on Board API request failed after retries")
}

// --------------------------------------------------------------------------- wire shapes

interface Ref<A> {
  data: { id: string | number; type: string; attributes?: A } | null
}

interface RefList<A> {
  data: Array<{ id: string | number; type: string; attributes?: A }>
}

/** A Get on Board job as the public search/company endpoints return it (fields this skill reads). */
export interface GobJob {
  id: string
  type: string
  attributes: {
    title: string
    description_headline?: string | null
    description?: string | null
    projects?: string | null
    functions_headline?: string | null
    functions?: string | null
    benefits_headline?: string | null
    benefits?: string | null
    desirable_headline?: string | null
    desirable?: string | null
    remote?: boolean
    remote_modality?: string | null
    remote_zone?: string | null
    countries?: string[]
    lang?: string | null
    category_name?: string | null
    min_salary?: number | null
    max_salary?: number | null
    published_at?: number | null
    company?: Ref<{ name?: string }>
    seniority?: Ref<{ name?: string }>
    location_cities?: RefList<{ name?: string; country?: string }>
    location_tenants?: RefList<{ name?: string }>
    location_regions?: RefList<{ name?: string }>
  }
  links?: { public_url?: string }
}

export interface ListEnvelope {
  data: GobJob[]
  meta?: { page?: number; per_page?: number; total_pages?: number }
}

/**
 * A search result in the portal-skill contract shape. `id` is
 * `<company-slug>/<job-slug>`: the public API has no single-job endpoint, so
 * `detail` needs the company to find the job among that company's listings.
 * Missing values are `null`, never omitted.
 */
export interface JobResult {
  id: string
  title: string
  company: string | null
  company_slug: string | null
  location: string | null
  date: string | null
  url: string
  remote_modality: string | null
  seniority: string | null
  category: string | null
  salary: string | null
  description: string | null
}

// --------------------------------------------------------------------------- reshaping

/** `YYYY-MM-DD` from a Unix-seconds timestamp, or null. */
export function contractDate(epochSeconds: number | null | undefined): string | null {
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds) || epochSeconds <= 0) return null
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10)
}

const MODALITY_LABEL: Record<string, string> = {
  fully_remote: "Remote (anywhere)",
  remote_local: "Remote",
  temporarily_remote: "Remote (temporary)",
  hybrid: "Hybrid",
  no_remote: "On-site",
}

/**
 * One readable location line: the work mode plus the cities (or countries) the
 * posting names, e.g. "Hybrid · Lima, Peru" or "Remote · Peru, Chile". The
 * mode words are what job_alerts.py's presencial / remote patterns read.
 */
export function locationLine(a: GobJob["attributes"]): string | null {
  const cities = (a.location_cities?.data ?? [])
    .map((c) => [c.attributes?.name, c.attributes?.country].filter(Boolean).join(", "))
    .filter(Boolean)
  const names = (list: RefList<{ name?: string }> | undefined) =>
    (list?.data ?? []).map((t) => t.attributes?.name?.trim() ?? "").filter(Boolean)
  // Remote postings name where a remote hire may live as countries (tenants)
  // or regions; long lists are cut so the line stays readable.
  const shortList = (items: string[]) => (items.length > 5 ? `${items.slice(0, 5).join(", ")} +${items.length - 5}` : items.join(", "))
  const tenants = names(a.location_tenants)
  const regions = names(a.location_regions)
  const countries = (a.countries ?? []).filter((c) => c && c.toLowerCase() !== "remote")
  const place = cities.length
    ? cities.join("; ")
    : tenants.length
      ? shortList(tenants)
      : regions.length
        ? shortList(regions)
        : countries.join(", ")
  const mode = a.remote_modality ? MODALITY_LABEL[a.remote_modality] ?? a.remote_modality : a.remote ? "Remote" : null
  const parts = [mode, place].filter(Boolean)
  return parts.length ? parts.join(" · ") : null
}

function salaryLine(a: GobJob["attributes"]): string | null {
  const min = a.min_salary ?? null
  const max = a.max_salary ?? null
  if (min == null && max == null) return null
  if (min != null && max != null) return `USD ${min}–${max}/month`
  return `USD ${min ?? max}/month`
}

/** The posting text: each section's headline and cleaned body, in reading order. */
export function fullDescription(a: GobJob["attributes"]): string | null {
  const sections: Array<[string | null | undefined, string | null | undefined]> = [
    [a.functions_headline, a.functions],
    [a.description_headline, a.description],
    [a.desirable_headline, a.desirable],
    [a.benefits_headline, a.benefits],
    ["About the company / project", a.projects],
  ]
  const blocks = sections
    .map(([head, body]) => {
      const text = cleanHtml(body)
      if (!text) return null
      const h = (head ?? "").trim()
      return h ? `${h}\n${text}` : text
    })
    .filter((b): b is string => b !== null)
  return blocks.length ? blocks.join("\n\n") : null
}

export function toResult(j: GobJob): JobResult {
  const a = j.attributes
  const companySlug = a.company?.data?.id != null ? String(a.company.data.id) : null
  // An unexpanded company ref carries a numeric id, not a slug - only a slug
  // can be passed back to /companies/{slug}/jobs.
  const slugOk = companySlug !== null && !/^\d+$/.test(companySlug)
  return {
    id: slugOk ? `${companySlug}/${j.id}` : j.id,
    title: decodeHtmlEntities(a.title || "").trim() || "(untitled)",
    company: a.company?.data?.attributes?.name?.trim() || null,
    company_slug: slugOk ? companySlug : null,
    location: locationLine(a),
    date: contractDate(a.published_at),
    url: j.links?.public_url || `${BASE_URL}/jobs/${j.id}`,
    remote_modality: a.remote_modality ?? null,
    seniority: a.seniority?.data?.attributes?.name ?? null,
    category: a.category_name ?? null,
    salary: salaryLine(a),
    description: fullDescription(a),
  }
}

// --------------------------------------------------------------------------- text

function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => numericEntity(parseInt(dec, 10)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => numericEntity(parseInt(hex, 16)))
    .replace(/&amp;/g, "&")
}

/** HTML to readable prose: block tags become newlines, entities decoded, tags removed. */
export function cleanHtml(html: string | null | undefined): string | null {
  if (!html) return null
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|li|ul|ol|div|h\d)>/gi, "\n")
  const text = decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n\n(?=- )/g, "\n")
    .trim()
  return text || null
}

// --------------------------------------------------------------------------- ids

const GOB_HOST = /(^|\.)getonbrd\.com$/i
const SLUG = /^[a-z0-9][a-z0-9-]*$/i

/**
 * Parse a `detail` argument into {company, job}. Accepts `<company>/<job>` (the
 * search result id), or a bare job slug / getonbrd.com job URL together with
 * `--company`. A URL on any other host is rejected.
 */
export function parseJobRef(input: string, company?: string): { company: string; job: string } | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  let job: string | null = null
  let comp: string | null = company?.trim() || null
  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return null
    }
    if (!GOB_HOST.test(parsed.hostname)) return null
    const segments = parsed.pathname.split("/").filter(Boolean)
    if (segments[0] !== "jobs" || segments.length < 2) return null
    job = segments[segments.length - 1]
  } else if (trimmed.includes("/")) {
    const [c, j, ...rest] = trimmed.split("/")
    if (rest.length) return null
    comp = comp ?? c
    job = j
  } else {
    job = trimmed
  }
  if (!job || !comp || !SLUG.test(job) || !SLUG.test(comp)) return null
  return { company: comp, job }
}
