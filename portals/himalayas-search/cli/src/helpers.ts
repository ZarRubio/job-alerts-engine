// Data source: the Himalayas public Remote Jobs JSON API. No key is required;
// an optional free key (HIMALAYAS_API_TOKEN) only raises the rate limit.
//
// API terms this CLI honours:
//  - every Apply link is the API's `applicationLink`, unchanged - it is each
//    result's `url`;
//  - Himalayas is shown as the source (`source: "Himalayas"` on every result);
//  - jobs are not passed on to other job boards or aggregators (personal use);
//  - closed jobs are dropped: `detail` reports a 410 as `isActive: false`.

export const BASE_URL = "https://himalayas.app"
export const SEARCH_PATH = "/jobs/api/search"
export const SOURCE = "Himalayas"

const UA = "Mozilla/5.0 (compatible; himalayas-cli/1.0)"

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

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

/** The optional API key, read only from the environment and never printed. */
function authHeader(): Record<string, string> {
  const token = (process.env.HIMALAYAS_API_TOKEN ?? "").trim()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export type ApiResult<T> = { status: "ok"; body: T } | { status: "not_found" } | { status: "gone"; body: unknown }

/**
 * GET JSON from the Himalayas API. Retries 429/5xx with exponential backoff
 * plus jitter, honouring Retry-After within a budget. 404 and 410 (a closed
 * job) are returned to the caller rather than thrown.
 */
export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const url = `${BASE_URL}${path}`
  const maxRetries = 6
  let delay = 500
  let waited = 0

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json", ...authHeader() },
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      })
    } catch (e) {
      throw new Error(`could not reach the Himalayas API (${e instanceof Error ? e.message : String(e)})`)
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`Himalayas API request failed: ${response.status} ${response.statusText}`)
      }
      const backoff = delay + Math.floor(Math.random() * 500)
      const wait = Math.max(backoff, retryAfterMs(response.headers.get("Retry-After")) ?? 0)
      if (waited + wait > RETRY_BUDGET_MS) {
        throw new Error(
          `Himalayas API request failed: ${response.status}; the server asked to retry in ` +
            `${Math.ceil(wait / 1000)}s, past this CLI's ${RETRY_BUDGET_MS / 1000}s retry budget`,
        )
      }
      await sleep(wait)
      waited += wait
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return { status: "not_found" }
    const body = (await response.json().catch(() => null)) as T | null
    if (response.status === 410) return { status: "gone", body }
    if (response.status === 401) {
      throw new Error("Himalayas API answered 401: HIMALAYAS_API_TOKEN is invalid, revoked or unverified - fix it or unset it")
    }
    if (!response.ok) throw new Error(`Himalayas API request failed: ${response.status} ${response.statusText}`)
    if (!body) throw new Error("Himalayas API returned an unparseable response body")
    return { status: "ok", body }
  }
  throw new Error("Himalayas API request failed after retries")
}

/** A Himalayas job as the API returns it (fields this skill reads). */
export interface HimalayasJob {
  title: string
  excerpt?: string | null
  companyName?: string | null
  companySlug?: string | null
  employmentType?: string | null
  minSalary?: number | null
  maxSalary?: number | null
  salaryPeriod?: string | null
  currency?: string | null
  seniority?: string[]
  locationRestrictions?: string[]
  timezoneRestrictions?: number[]
  categories?: string[]
  description?: string | null
  pubDate?: number | null
  expiryDate?: number | null
  applicationLink?: string | null
  guid: string
}

export interface SearchEnvelope {
  totalCount?: number
  jobs?: HimalayasJob[]
}

/** A search result in the portal-skill contract shape; missing values are `null`. */
export interface JobResult {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  url: string
  source: string
  location_restrictions: string[]
  timezone_restrictions: number[]
  seniority: string[]
  employment_type: string | null
  salary: string | null
  description: string | null
}

export function contractDate(epochSeconds: number | null | undefined): string | null {
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds) || epochSeconds <= 0) return null
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10)
}

/**
 * "Remote · Worldwide" when the job has no location restriction, otherwise
 * "Remote · <countries>" with `preferred` (the country searched for) first and
 * long lists cut, so the line stays readable in an alert.
 */
export function locationLine(restrictions: string[] | undefined, preferred?: string): string {
  const list = (restrictions ?? []).filter(Boolean)
  if (list.length === 0) return "Remote · Worldwide"
  const want = (preferred ?? "").trim().toLowerCase()
  const ordered = want ? [...list.filter((c) => c.toLowerCase() === want), ...list.filter((c) => c.toLowerCase() !== want)] : list
  const shown = ordered.length > 5 ? `${ordered.slice(0, 5).join(", ")} +${ordered.length - 5}` : ordered.join(", ")
  return `Remote · ${shown}`
}

function salaryLine(j: HimalayasJob): string | null {
  if (j.minSalary == null && j.maxSalary == null) return null
  const cur = j.currency ? `${j.currency} ` : ""
  const per = j.salaryPeriod ? `/${j.salaryPeriod}` : ""
  if (j.minSalary != null && j.maxSalary != null) return `${cur}${j.minSalary}–${j.maxSalary}${per}`
  return `${cur}${j.minSalary ?? j.maxSalary}${per}`
}

/** `<company>/<slug>` from a guid like https://himalayas.app/companies/<company>/jobs/<slug>. */
export function idFromGuid(guid: string): string | null {
  const m = /\/companies\/([^/?#]+)\/jobs\/([^/?#]+)/.exec(guid)
  return m ? `${m[1]}/${m[2]}` : null
}

export function cleanText(text: string | null | undefined): string | null {
  if (!text) return null
  const out = text
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return out || null
}

export function toResult(j: HimalayasJob, preferredCountry?: string): JobResult {
  return {
    id: idFromGuid(j.guid) ?? j.guid,
    title: (j.title || "").trim() || "(untitled)",
    company: j.companyName?.trim() || null,
    location: locationLine(j.locationRestrictions, preferredCountry),
    date: contractDate(j.pubDate),
    // The terms require the API's applicationLink, unchanged, for every Apply action.
    url: j.applicationLink || j.guid,
    source: SOURCE,
    location_restrictions: j.locationRestrictions ?? [],
    timezone_restrictions: j.timezoneRestrictions ?? [],
    seniority: j.seniority ?? [],
    employment_type: j.employmentType ?? null,
    salary: salaryLine(j),
    description: cleanText(j.description),
  }
}

const HIMALAYAS_HOST = /(^|\.)himalayas\.app$/i
const SEG = /^[a-z0-9][a-z0-9._~%-]*$/i

/** {company, slug} from `<company>/<slug>` or a himalayas.app job URL. */
export function parseJobRef(input: string): { company: string; slug: string } | null {
  const trimmed = input.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return null
    }
    if (!HIMALAYAS_HOST.test(parsed.hostname)) return null
    const m = /^(?:\/jobs\/api)?\/companies\/([^/]+)\/jobs\/([^/]+)\/?$/.exec(parsed.pathname)
    return m ? { company: m[1], slug: m[2] } : null
  }
  const parts = trimmed.split("/")
  if (parts.length !== 2 || !SEG.test(parts[0]) || !SEG.test(parts[1])) return null
  return { company: parts[0], slug: parts[1] }
}
