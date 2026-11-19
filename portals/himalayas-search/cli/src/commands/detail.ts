import { apiGet, parseJobRef, toResult, writeError, type HimalayasJob, type JobResult } from "../helpers.js"

export interface DetailOpts {
  id: string // <company>/<slug> (a search result id) or a himalayas.app job URL
  format: "json" | "plain"
}

function renderPlain(job: JobResult, active: boolean): string {
  const lines = [job.title, `${job.company ?? "—"} · ${job.location ?? "—"}`]
  if (!active) lines.push("Status: CLOSED")
  if (job.date) lines.push(`Posted: ${job.date}`)
  if (job.seniority.length) lines.push(`Seniority: ${job.seniority.join(", ")}`)
  if (job.employment_type) lines.push(`Employment: ${job.employment_type}`)
  if (job.salary) lines.push(`Salary: ${job.salary}`)
  if (job.timezone_restrictions.length) lines.push(`Timezones (UTC): ${job.timezone_restrictions.join(", ")}`)
  lines.push("", job.description ?? "(no description)", "", `Apply: ${job.url}`, `id: ${job.id}`, "Source: Himalayas (himalayas.app)")
  return lines.join("\n")
}

/**
 * The API's "check one job" endpoint: 200 = open, 410 = closed (reported as
 * `isActive: false` so callers drop it), 404 = no such job.
 */
export async function runDetail(opts: DetailOpts): Promise<number> {
  const ref = parseJobRef(opts.id)
  if (!ref) {
    writeError(`could not parse a Himalayas job from "${opts.id}" - pass <company>/<slug> or a himalayas.app job URL`, "BAD_ID")
    return 1
  }
  try {
    const res = await apiGet<{ job?: HimalayasJob }>(
      `/jobs/api/companies/${encodeURIComponent(ref.company)}/jobs/${encodeURIComponent(ref.slug)}`,
    )
    if (res.status === "not_found") {
      writeError("job not found", "NOT_FOUND")
      return 1
    }
    const active = res.status === "ok"
    const wire = active ? res.body.job : ((res.body as { job?: HimalayasJob } | null)?.job ?? null)
    const job: JobResult = wire
      ? toResult(wire)
      : {
          id: `${ref.company}/${ref.slug}`,
          title: "(closed)",
          company: null,
          location: null,
          date: null,
          url: `https://himalayas.app/companies/${ref.company}/jobs/${ref.slug}`,
          source: "Himalayas",
          location_restrictions: [],
          timezone_restrictions: [],
          seniority: [],
          employment_type: null,
          salary: null,
          description: null,
        }
    process.stdout.write((opts.format === "plain" ? renderPlain(job, active) : JSON.stringify({ ...job, isActive: active }, null, 2)) + "\n")
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
