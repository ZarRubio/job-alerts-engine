import { API_PATH, apiGet, parseJobId, toResult, writeError, type Envelope, type JobResult } from "../helpers.js"

export interface DetailOpts {
  id: string // numeric Remotive id or a remotive.com job URL
  category?: string // narrows the one list request
  format: "json" | "plain"
}

function renderPlain(job: JobResult): string {
  const lines = [job.title, `${job.company ?? "—"} · ${job.location ?? "—"}`]
  if (job.date) lines.push(`Posted: ${job.date}`)
  if (job.category) lines.push(`Category: ${job.category}`)
  if (job.job_type) lines.push(`Type: ${job.job_type}`)
  if (job.salary) lines.push(`Salary: ${job.salary}`)
  lines.push("", job.description ?? "(no description)", "", `URL: ${job.url}`, `id: ${job.id}`, "Source: Remotive (remotive.com)")
  return lines.join("\n")
}

/**
 * Remotive has no single-job endpoint: detail makes the same single list request
 * a search does (narrowed by --category when given) and picks the id. A search
 * result already carries the full description, so detail is rarely needed - and
 * each call counts against Remotive's advised few requests a day.
 */
export async function runDetail(opts: DetailOpts): Promise<number> {
  const id = parseJobId(opts.id)
  if (!id) {
    writeError(`could not parse a Remotive job id from "${opts.id}"`, "BAD_ID")
    return 1
  }
  try {
    const qs = opts.category ? `?${new URLSearchParams({ category: opts.category })}` : ""
    const env = await apiGet<Envelope>(`${API_PATH}${qs}`)
    const hit = (env?.jobs ?? []).find((j) => String(j.id) === id)
    if (!hit) {
      writeError(`job ${id} is not among Remotive's active listings (closed or wrong id)`, "NOT_FOUND")
      return 1
    }
    const job = toResult(hit)
    process.stdout.write((opts.format === "plain" ? renderPlain(job) : JSON.stringify({ ...job, isActive: true }, null, 2)) + "\n")
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
