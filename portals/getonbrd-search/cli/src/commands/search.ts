import { apiGet, EXPAND, toResult, writeError, type JobResult, type ListEnvelope } from "../helpers.js"

const SEARCH_PATH = "/api/v0/search/jobs"
// The API's own maximum page size; fewer, larger pages keep request volume low.
const PER_PAGE = 100

export interface SearchOpts {
  query?: string
  country?: string // ISO-3166 alpha-2, lower-cased (country_code)
  remote: boolean // remote=true (the API refuses it together with country_code)
  categories: string[] // client-side match on category_name (case-insensitive substring)
  jobage: number // days; 9999 = no filter
  page: number // first API page to read
  maxPages: number // API pages to read from `page` on
  limit: number // client-side cap on printed results
  format: "json" | "table" | "plain"
  now?: number // for tests
}

export function buildParams(opts: SearchOpts, page: number): URLSearchParams {
  const p = new URLSearchParams()
  if (opts.query) p.set("query", opts.query)
  if (opts.country) p.set("country_code", opts.country)
  if (opts.remote) p.set("remote", "true")
  p.set("per_page", String(PER_PAGE))
  p.set("page", String(page))
  p.set("lang", "en")
  p.set("expand", EXPAND)
  return p
}

/** Recency, category filter, newest first, capped - all client-side (the API has no date filter). */
export function selectResults(rows: JobResult[], opts: SearchOpts): JobResult[] {
  const now = opts.now ?? Date.now()
  const cutoff = opts.jobage > 0 && opts.jobage < 9999 ? new Date(now - opts.jobage * 86_400_000).toISOString().slice(0, 10) : null
  const cats = opts.categories.map((c) => c.toLowerCase())
  const seen = new Set<string>()
  return rows
    .filter((r) => {
      if (seen.has(r.url)) return false
      seen.add(r.url)
      return true
    })
    .filter((r) => cutoff === null || (r.date !== null && r.date >= cutoff))
    .filter((r) => cats.length === 0 || cats.some((c) => (r.category ?? "").toLowerCase().includes(c)))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, opts.limit)
}

function renderTable(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  const columns: Array<{ header: string; width: number; cell: (r: JobResult) => string }> = [
    { header: "TITLE", width: 40, cell: (r) => r.title },
    { header: "COMPANY", width: 22, cell: (r) => r.company ?? "—" },
    { header: "LOCATION", width: 26, cell: (r) => r.location ?? "—" },
    { header: "DATE", width: 10, cell: (r) => r.date ?? "—" },
    { header: "ID", width: Math.max(2, ...rows.map((r) => r.id.length)), cell: (r) => r.id },
  ]
  const row = (cells: string[]) => cells.map((c, i) => c.slice(0, columns[i].width).padEnd(columns[i].width)).join("  ")
  const header = row(columns.map((c) => c.header))
  return [header, "-".repeat(header.length), ...rows.map((r) => row(columns.map((c) => c.cell(r))))].join("\n")
}

function renderPlain(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  return rows
    .map((r) =>
      [r.title, `  ${r.company ?? "—"} · ${r.location ?? "—"} · ${r.date ?? "—"}`, `  id: ${r.id}`, `  ${r.url}`].join("\n"),
    )
    .join("\n\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const rows: JobResult[] = []
    let total = 0
    for (let page = opts.page; page < opts.page + opts.maxPages; page++) {
      const env = await apiGet<ListEnvelope>(`${SEARCH_PATH}?${buildParams(opts, page).toString()}`)
      if (!env) {
        writeError(`${SEARCH_PATH} not found - the Get on Board API may have moved`, "SEARCH_FAILED")
        return 1
      }
      const data = Array.isArray(env.data) ? env.data : []
      rows.push(...data.map(toResult))
      total = env.meta?.total_pages ?? page
      if (data.length === 0 || page >= total) break
    }
    const results = selectResults(rows, opts)

    if (opts.format === "table") {
      process.stdout.write(renderTable(results) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(results) + "\n")
    } else {
      process.stdout.write(
        JSON.stringify({ meta: { count: results.length, page: opts.page, fetched: rows.length, total_pages: total }, results }, null, 2) +
          "\n",
      )
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
