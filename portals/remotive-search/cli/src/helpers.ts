// Data source: Remotive's public remote-jobs API, one JSON endpoint
// (`/api/remote-jobs`) that returns every active listing matching optional
// category / search / company filters. No authentication.
//
// Terms (from the API's own legal notice, repeated in every response):
//  - link back to the Remotive job URL AND name Remotive as the source;
//  - no need to call more than a couple of times a day (they advise max 4/day,
//    and block more than 2 requests per minute);
//  - listings are delayed 24 hours;
//  - do not resubmit the jobs to third-party job sites.
// This CLI therefore makes exactly one request per `search`, keeps the
// Remotive URL as each result's `url`, and labels every result `source: "Remotive"`.

export const BASE_URL = "https://remotive.com"
export const API_PATH = "/api/remote-jobs"
export const SOURCE = "Remotive"

const UA = "Mozilla/5.0 (compatible; remotive-cli/1.0)"

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

/**
 * GET JSON from the Remotive API. Retries 429/5xx with exponential backoff plus
 * jitter, but never sooner than 30 s after a 429 (Remotive blocks more than two
 * requests a minute), within a total budget; `null` on 404.
 */
export async function apiGet<T>(path: string): Promise<T | null> {
  const url = `${BASE_URL}${path}`
  const maxRetries = 6
  let delay = 1000
  let waited = 0

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
      })
    } catch (e) {
      throw new Error(`could not reach the Remotive API (${e instanceof Error ? e.message : String(e)})`)
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`Remotive API request failed: ${response.status} ${response.statusText}`)
      }
      const backoff = delay + Math.floor(Math.random() * 500)
      const floor = response.status === 429 ? 30_000 : 0
      const wait = Math.max(backoff, floor, retryAfterMs(response.headers.get("Retry-After")) ?? 0)
      if (waited + wait > RETRY_BUDGET_MS * 2) {
        throw new Error(
          `Remotive API request failed: ${response.status}; retrying would take ${Math.ceil(wait / 1000)}s, past this CLI's retry budget`,
        )
      }
      await sleep(wait)
      waited += wait
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return null

    const body = (await response.json().catch(() => null)) as T | null
    if (!response.ok) throw new Error(`Remotive API request failed: ${response.status} ${response.statusText}`)
    if (!body) throw new Error("Remotive API returned an unparseable response body")
    return body
  }
  throw new Error("Remotive API request failed after retries")
}

/** A Remotive job as the API returns it (fields this skill reads). */
export interface RemotiveJob {
  id: number | string
  url: string
  title: string
  company_name?: string | null
  category?: string | null
  tags?: string[]
  job_type?: string | null
  publication_date?: string | null
  candidate_required_location?: string | null
  salary?: string | null
  description?: string | null
}

export interface Envelope {
  "job-count"?: number
  "total-job-count"?: number
  jobs?: RemotiveJob[]
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
  candidate_required_location: string | null
  category: string | null
  job_type: string | null
  salary: string | null
  tags: string[]
  description: string | null
}

export function contractDate(value: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value ?? "")
  return m ? m[1] : null
}

export function toResult(j: RemotiveJob): JobResult {
  const where = (j.candidate_required_location ?? "").trim()
  return {
    id: String(j.id),
    title: decodeHtmlEntities(j.title || "").trim() || "(untitled)",
    company: j.company_name?.trim() || null,
    // "Remote" first: job_alerts.py reads the work mode from this line.
    location: where ? `Remote · ${where}` : "Remote",
    date: contractDate(j.publication_date),
    url: j.url,
    source: SOURCE,
    candidate_required_location: where || null,
    category: j.category ?? null,
    job_type: j.job_type || null,
    salary: j.salary?.trim() || null,
    tags: Array.isArray(j.tags) ? j.tags : [],
    description: cleanHtml(j.description),
  }
}

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

const REMOTIVE_HOST = /(^|\.)remotive\.(com|io)$/i

/** A Remotive job id from a bare numeric id or a remotive.com job URL (`...-<id>`). */
export function parseJobId(input: string): string | null {
  const trimmed = input.trim()
  if (/^\d+$/.test(trimmed)) return trimmed
  if (!/^https?:\/\//i.test(trimmed)) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (!REMOTIVE_HOST.test(parsed.hostname)) return null
  const m = parsed.pathname.match(/-(\d+)\/?$/)
  return m ? m[1] : null
}

/** Case-insensitive "any of these terms appears" over a comma list; empty list matches all. */
export function matchesAny(value: string | null, terms: string[]): boolean {
  if (terms.length === 0) return true
  const hay = (value ?? "").toLowerCase()
  return terms.some((t) => hay.includes(t.toLowerCase()))
}
