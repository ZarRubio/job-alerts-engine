import { API_PATH, apiGet, matchesAny, toResult, writeError, type Envelope, type JobResult } from "../helpers.js"

export interface SearchOpts {
  query?: string // API `search` (title + description, partial match)
  category?: string // API `category` slug, e.g. software-dev
  company?: string // API `company_name` (partial match)
  locations: string[] // client-side: candidate_required_location contains any (comma = OR)
  jobage: number // days; 9999 = no filter (client-side)
  page: number // client-side page over the filtered list
  limit: number // client-side page size
  format: "json" | "table" | "plain"
  now?: number
}

export function buildParams(opts: SearchOpts): URLSearchParams {
  const p = new URLSearchParams()
  if (opts.category) p.set("category", opts.category)
  if (opts.query) p.set("search", opts.query)
  if (opts.company) p.set("company_name", opts.company)
  return p
}

export function selectResults(rows: JobResult[], opts: SearchOpts): JobResult[] {
  const now = opts.now ?? Date.now()
  const cutoff = opts.jobage > 0 && opts.jobage < 9999 ? new Date(now - opts.jobage * 86_400_000).toISOString().slice(0, 10) : null
  const filtered = rows
    .filter((r) => cutoff === null || (r.date !== null && r.date >= cutoff))
    .filter((r) => matchesAny(r.candidate_required_location, opts.locations))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
  const start = (opts.page - 1) * opts.limit
  return filtered.slice(start, start + opts.limit)
}

function renderTable(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  const columns: Array<{ header: string; width: number; cell: (r: JobResult) => string }> = [
    { header: "ID", width: Math.max(2, ...rows.map((r) => r.id.length)), cell: (r) => r.id },
    { header: "TITLE", width: 40, cell: (r) => r.title },
    { header: "COMPANY", width: 22, cell: (r) => r.company ?? "—" },
    { header: "LOCATION", width: 28, cell: (r) => r.candidate_required_location ?? "—" },
    { header: "DATE", width: 10, cell: (r) => r.date ?? "—" },
  ]
  const row = (cells: string[]) => cells.map((c, i) => c.slice(0, columns[i].width).padEnd(columns[i].width)).join("  ")
  const header = row(columns.map((c) => c.header))
  return [header, "-".repeat(header.length), ...rows.map((r) => row(columns.map((c) => c.cell(r)))), "", "Source: Remotive (remotive.com)"].join("\n")
}

function renderPlain(rows: JobResult[]): string {
  if (rows.length === 0) return "No results."
  return (
    rows
      .map((r) => [r.title, `  ${r.company ?? "—"} · ${r.location ?? "—"} · ${r.date ?? "—"}`, `  id: ${r.id}`, `  ${r.url}`].join("\n"))
      .join("\n\n") + "\n\nSource: Remotive (remotive.com)"
  )
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const qs = buildParams(opts).toString()
    const env = await apiGet<Envelope>(`${API_PATH}${qs ? `?${qs}` : ""}`)
    if (!env) {
      writeError(`${API_PATH} not found - the Remotive API may have moved`, "SEARCH_FAILED")
      return 1
    }
    const all = (Array.isArray(env.jobs) ? env.jobs : []).map(toResult)
    const results = selectResults(all, opts)
    if (opts.format === "table") {
      process.stdout.write(renderTable(results) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(results) + "\n")
    } else {
      process.stdout.write(
        JSON.stringify({ meta: { count: results.length, page: opts.page, fetched: all.length, source: "Remotive" }, results }, null, 2) + "\n",
      )
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
