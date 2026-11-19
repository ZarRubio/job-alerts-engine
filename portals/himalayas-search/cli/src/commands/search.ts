import { apiGet, SEARCH_PATH, toResult, writeError, type JobResult, type SearchEnvelope } from "../helpers.js"

export interface SearchOpts {
  query?: string // q
  country?: string // country: ISO alpha-2 or a country name (jobs open to that country)
  worldwide: boolean // worldwide=true: only worldwide-friendly jobs
  excludeWorldwide: boolean // exclude_worldwide=true: with --country, drop worldwide jobs
  seniority: string[] // Entry-level, Mid-level, Senior, Manager, Director, Executive
  employmentType: string[] // Full Time, Part Time, Contractor, ...
  timezone?: string // e.g. -5 or UTC-5
  sort: string // relevant | recent | ...
  jobage: number // days; 9999 = no filter (client-side, on pubDate)
  page: number // first API page (20 jobs each)
  maxPages: number // API pages to read from `page` on
  limit: number // client-side cap
  format: "json" | "table" | "plain"
  now?: number
}

export const SORTS = ["relevant", "recent", "salaryAsc", "salaryDesc", "nameAToZ", "nameZToA", "jobs"]

export function buildParams(opts: SearchOpts, page: number): URLSearchParams {
  const p = new URLSearchParams()
  if (opts.query) p.set("q", opts.query)
  if (opts.country) p.set("country", opts.country)
  if (opts.worldwide) p.set("worldwide", "true")
  if (opts.excludeWorldwide) p.set("exclude_worldwide", "true")
  if (opts.seniority.length) p.set("seniority", opts.seniority.join(","))
  if (opts.employmentType.length) p.set("employment_type", opts.employmentType.join(","))
  if (opts.timezone) p.set("timezone", opts.timezone)
  p.set("sort", opts.sort)
  p.set("page", String(page))
  return p
}

export function selectResults(rows: JobResult[], opts: SearchOpts): JobResult[] {
  const now = opts.now ?? Date.now()
  const cutoff = opts.jobage > 0 && opts.jobage < 9999 ? new Date(now - opts.jobage * 86_400_000).toISOString().slice(0, 10) : null
  const seen = new Set<string>()
  return rows
    .filter((r) => {
      if (seen.has(r.id)) return false
      seen.add(r.id)
      return true
    })
    .filter((r) => cutoff === null || (r.date !== null && r.date >= cutoff))
    .slice(0, opts.limit)
}

function renderTable(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  const columns: Array<{ header: string; width: number; cell: (r: JobResult) => string }> = [
    { header: "TITLE", width: 40, cell: (r) => r.title },
    { header: "COMPANY", width: 22, cell: (r) => r.company ?? "—" },
    { header: "LOCATION", width: 30, cell: (r) => r.location ?? "—" },
    { header: "DATE", width: 10, cell: (r) => r.date ?? "—" },
    { header: "ID", width: Math.max(2, ...rows.map((r) => r.id.length)), cell: (r) => r.id },
  ]
  const row = (cells: string[]) => cells.map((c, i) => c.slice(0, columns[i].width).padEnd(columns[i].width)).join("  ")
  const header = row(columns.map((c) => c.header))
  return [header, "-".repeat(header.length), ...rows.map((r) => row(columns.map((c) => c.cell(r)))), "", "Source: Himalayas (himalayas.app)"].join("\n")
}

function renderPlain(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  return (
    rows
      .map((r) => [r.title, `  ${r.company ?? "—"} · ${r.location ?? "—"} · ${r.date ?? "—"}`, `  id: ${r.id}`, `  ${r.url}`].join("\n"))
      .join("\n\n") + "\n\nSource: Himalayas (himalayas.app)"
  )
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const rows: JobResult[] = []
    for (let page = opts.page; page < opts.page + opts.maxPages; page++) {
      const res = await apiGet<SearchEnvelope>(`${SEARCH_PATH}?${buildParams(opts, page).toString()}`)
      if (res.status !== "ok") {
        writeError(`${SEARCH_PATH} answered ${res.status} - the Himalayas API may have moved`, "SEARCH_FAILED")
        return 1
      }
      const jobs = Array.isArray(res.body.jobs) ? res.body.jobs : []
      rows.push(...jobs.map((j) => toResult(j, opts.country)))
      // Every page holds 20 jobs except the last; an empty or short page ends the search.
      if (jobs.length < 20) break
      // With sort=recent, a page whose last (oldest) job is already past --jobage ends the walk.
      const oldest = rows[rows.length - 1]?.date
      if (opts.sort === "recent" && opts.jobage < 9999 && oldest) {
        const cutoff = new Date((opts.now ?? Date.now()) - opts.jobage * 86_400_000).toISOString().slice(0, 10)
        if (oldest < cutoff) break
      }
    }
    const results = selectResults(rows, opts)
    if (opts.format === "table") {
      process.stdout.write(renderTable(results) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(results) + "\n")
    } else {
      process.stdout.write(
        JSON.stringify({ meta: { count: results.length, page: opts.page, fetched: rows.length, source: "Himalayas" }, results }, null, 2) + "\n",
      )
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
