import { apiGet, EXPAND, parseJobRef, toResult, writeError, type JobResult, type ListEnvelope } from "../helpers.js"

export interface DetailOpts {
  id: string // <company-slug>/<job-slug>, or a job slug / getonbrd.com URL with `company`
  company?: string
  format: "json" | "plain"
}

// The public API has no single-job endpoint (/api/v0/jobs/{id} is the private,
// company-authenticated one), so detail reads the company's published jobs and
// picks the one with this slug. A company rarely has more than a page of them.
const MAX_PAGES = 3

function renderPlain(job: JobResult): string {
  const lines = [job.title, `${job.company ?? "—"} · ${job.location ?? "—"}`]
  if (job.date) lines.push(`Posted: ${job.date}`)
  if (job.seniority) lines.push(`Seniority: ${job.seniority}`)
  if (job.category) lines.push(`Category: ${job.category}`)
  if (job.salary) lines.push(`Salary: ${job.salary}`)
  lines.push("", job.description ?? "(no description)", "", `URL: ${job.url}`, `id: ${job.id}`)
  return lines.join("\n")
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const ref = parseJobRef(opts.id, opts.company)
  if (!ref) {
    writeError(
      `could not parse a Get on Board job from "${opts.id}" - pass <company-slug>/<job-slug> (a search result id), or a job slug or getonbrd.com URL with --company <company-slug>`,
      "BAD_ID",
    )
    return 1
  }
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const params = new URLSearchParams({ per_page: "100", page: String(page), lang: "en", expand: EXPAND })
      const env = await apiGet<ListEnvelope>(`/api/v0/companies/${encodeURIComponent(ref.company)}/jobs?${params}`)
      if (!env) {
        writeError(`company "${ref.company}" not found`, "NOT_FOUND")
        return 1
      }
      const data = Array.isArray(env.data) ? env.data : []
      const hit = data.find((j) => j.id === ref.job)
      if (hit) {
        // The company endpoint does not always echo the company inside each job;
        // keep the slug the caller gave so the id round-trips.
        const job = toResult(hit)
        if (!job.company_slug) {
          job.company_slug = ref.company
          job.id = `${ref.company}/${hit.id}`
        }
        process.stdout.write((opts.format === "plain" ? renderPlain(job) : JSON.stringify({ ...job, isActive: true }, null, 2)) + "\n")
        return 0
      }
      if (data.length === 0 || page >= (env.meta?.total_pages ?? page)) break
    }
    writeError(`job "${ref.job}" is not among ${ref.company}'s published jobs (closed or wrong id)`, "NOT_FOUND")
    return 1
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
