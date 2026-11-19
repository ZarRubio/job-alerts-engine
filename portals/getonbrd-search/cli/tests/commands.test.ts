import { afterEach, describe, expect, test } from "bun:test"
import { runSearch, type SearchOpts } from "../src/commands/search"
import { runDetail } from "../src/commands/detail"
import { cleanHtml, contractDate, locationLine, parseJobRef, retryAfterMs, toResult, type GobJob } from "../src/helpers"

// Network-free: fetch is stubbed with fixtures shaped like the live API's
// /api/v0/search/jobs response (verified against the real endpoint).

const originalFetch = globalThis.fetch
const originalStdoutWrite = process.stdout.write
const originalStderrWrite = process.stderr.write

afterEach(() => {
  globalThis.fetch = originalFetch
  process.stdout.write = originalStdoutWrite
  process.stderr.write = originalStderrWrite
})

function capture(stream: "stdout" | "stderr"): { get: () => string } {
  let buf = ""
  process[stream].write = ((chunk: string | Uint8Array) => {
    buf += chunk.toString()
    return true
  }) as typeof process.stdout.write
  return { get: () => buf }
}

const NOW = Date.parse("2026-11-12T12:00:00Z")
const day = (iso: string) => Math.floor(Date.parse(`${iso}T10:00:00Z`) / 1000)

function gobJob(overrides: Partial<GobJob["attributes"]> & { id?: string } = {}): GobJob {
  const { id = "full-stack-software-engineer-acme-lima", ...attrs } = overrides
  return {
    id,
    type: "job",
    attributes: {
      title: "Full-Stack Software Engineer",
      functions_headline: "Responsabilidades",
      functions: "<ul><li>Construir APIs con Node.js</li><li>React &amp; Next.js</li></ul>",
      description_headline: "Requisitos",
      description: "<p>2+ años con TypeScript</p>",
      desirable: "",
      benefits: "",
      projects: "<p>Startup peruana</p>",
      remote: false,
      remote_modality: "hybrid",
      countries: ["Peru"],
      category_name: "Programming",
      min_salary: 1500,
      max_salary: 2500,
      published_at: day("2026-11-10"),
      company: { data: { id: "acme", type: "company", attributes: { name: "Acme SAC" } } },
      seniority: { data: { id: "3", type: "seniority", attributes: { name: "Semi Senior" } } },
      location_cities: { data: [{ id: "130", type: "tenant_city", attributes: { name: "Lima", country: "Peru" } }] },
      location_tenants: { data: [] },
      location_regions: { data: [] },
      ...attrs,
    },
    links: { public_url: `https://www.getonbrd.com/jobs/${id}` },
  }
}

function mockFetch(pages: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>): { urls: string[] } {
  const urls: string[] = []
  let i = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const page = pages[Math.min(i++, pages.length - 1)]
    return new Response(JSON.stringify(page.body), {
      status: page.status ?? 200,
      headers: { "content-type": "application/json", ...(page.headers ?? {}) },
    })
  }) as typeof fetch
  return { urls }
}

const baseOpts: SearchOpts = {
  remote: false,
  categories: [],
  jobage: 9999,
  page: 1,
  maxPages: 3,
  limit: 25,
  format: "json",
  now: NOW,
}

describe("toResult", () => {
  test("reshapes a job into the contract fields with a company/job id", () => {
    const r = toResult(gobJob())
    expect(r.id).toBe("acme/full-stack-software-engineer-acme-lima")
    expect(r.title).toBe("Full-Stack Software Engineer")
    expect(r.company).toBe("Acme SAC")
    expect(r.location).toBe("Hybrid · Lima, Peru")
    expect(r.date).toBe("2026-11-10")
    expect(r.url).toBe("https://www.getonbrd.com/jobs/full-stack-software-engineer-acme-lima")
    expect(r.seniority).toBe("Semi Senior")
    expect(r.salary).toBe("USD 1500–2500/month")
    expect(r.description).toContain("Responsabilidades\n- Construir APIs con Node.js\n- React & Next.js")
    expect(r.description).toContain("Requisitos\n2+ años con TypeScript")
  })

  test("remote postings name the countries a hire may live in", () => {
    const r = toResult(
      gobJob({
        remote: true,
        remote_modality: "remote_local",
        countries: ["Remote"],
        location_cities: { data: [] },
        location_tenants: {
          data: ["Peru", "Chile", "Mexico", "Colombia", "Argentina", "Uruguay"].map((name) => ({
            id: name.toLowerCase(),
            type: "country",
            attributes: { name },
          })),
        },
      }),
    )
    expect(r.location).toBe("Remote · Peru, Chile, Mexico, Colombia, Argentina +1")
  })

  test("an unexpanded company ref keeps the bare job slug as id", () => {
    const r = toResult(gobJob({ company: { data: { id: 9458, type: "company" } } }))
    expect(r.id).toBe("full-stack-software-engineer-acme-lima")
    expect(r.company).toBeNull()
    expect(r.company_slug).toBeNull()
  })

  test("missing values are null, never omitted", () => {
    const r = toResult(gobJob({ published_at: null, min_salary: null, max_salary: null, remote_modality: null, location_cities: { data: [] }, countries: [] }))
    expect(r.date).toBeNull()
    expect(r.salary).toBeNull()
    expect(r.location).toBeNull()
  })
})

describe("helpers", () => {
  test("contractDate and cleanHtml", () => {
    expect(contractDate(day("2026-01-02"))).toBe("2026-01-02")
    expect(contractDate(undefined)).toBeNull()
    expect(cleanHtml("<p>a &amp;lt; b</p>c<br>d")).toBe("a &lt; b\nc\nd")
    expect(cleanHtml("")).toBeNull()
  })

  test("retryAfterMs reads seconds and dates", () => {
    expect(retryAfterMs("3")).toBe(3000)
    expect(retryAfterMs(null)).toBeNull()
    expect(retryAfterMs("garbage")).toBeNull()
  })

  test("parseJobRef accepts ids, slugs with a company and getonbrd URLs only", () => {
    expect(parseJobRef("acme/dev-job")).toEqual({ company: "acme", job: "dev-job" })
    expect(parseJobRef("dev-job", "acme")).toEqual({ company: "acme", job: "dev-job" })
    expect(parseJobRef("https://www.getonbrd.com/jobs/programming/dev-job", "acme")).toEqual({ company: "acme", job: "dev-job" })
    expect(parseJobRef("dev-job")).toBeNull()
    expect(parseJobRef("https://evil.example.com/jobs/dev-job", "acme")).toBeNull()
    expect(parseJobRef("a/b/c")).toBeNull()
  })

  test("locationLine labels on-site postings", () => {
    expect(locationLine(gobJob({ remote_modality: "no_remote" }).attributes)).toBe("On-site · Lima, Peru")
  })
})

describe("runSearch", () => {
  test("sends the query, country and expand params, then filters by age and sorts newest first", async () => {
    const mock = mockFetch([
      {
        body: {
          data: [
            gobJob({ id: "old-job", published_at: day("2026-10-01") }),
            gobJob({ id: "new-job", published_at: day("2026-11-11") }),
            gobJob({ id: "mid-job", published_at: day("2026-11-09") }),
          ],
          meta: { page: 1, per_page: 100, total_pages: 1 },
        },
      },
    ])
    const out = capture("stdout")
    const code = await runSearch({ ...baseOpts, query: "react", country: "pe", jobage: 7 })
    expect(code).toBe(0)
    const params = new URL(mock.urls[0]).searchParams
    expect(params.get("query")).toBe("react")
    expect(params.get("country_code")).toBe("pe")
    expect(params.get("per_page")).toBe("100")
    expect(params.get("expand")).toContain("company")
    expect(params.has("remote")).toBe(false)
    expect(mock.urls).toHaveLength(1) // total_pages = 1: no second request
    const parsed = JSON.parse(out.get())
    expect(parsed.results.map((r: { id: string }) => r.id)).toEqual(["acme/new-job", "acme/mid-job"])
    expect(parsed.meta.count).toBe(2)
  })

  test("reads up to --max-pages pages and applies the category filter and limit", async () => {
    const mock = mockFetch([
      { body: { data: [gobJob({ id: "a" }), gobJob({ id: "b", category_name: "Sales" })], meta: { total_pages: 5 } } },
      { body: { data: [gobJob({ id: "c", category_name: "Machine Learning & AI" })], meta: { total_pages: 5 } } },
    ])
    const out = capture("stdout")
    const code = await runSearch({ ...baseOpts, maxPages: 2, categories: ["programming", "machine learning"], limit: 5 })
    expect(code).toBe(0)
    expect(mock.urls).toHaveLength(2)
    expect(new URL(mock.urls[1]).searchParams.get("page")).toBe("2")
    const ids = JSON.parse(out.get()).results.map((r: { id: string }) => r.id)
    expect(ids.sort()).toEqual(["acme/a", "acme/c"])
  })

  test("an API error message is surfaced on stderr with exit 1", async () => {
    mockFetch([{ status: 422, body: { message: "Localization conflict.", code: "unprocessable_content" } }])
    const err = capture("stderr")
    const code = await runSearch({ ...baseOpts, country: "pe", remote: true })
    expect(code).toBe(1)
    expect(JSON.parse(err.get())).toEqual({ error: "Localization conflict.", code: "SEARCH_FAILED" })
  })

  test("a 503 is retried before succeeding", async () => {
    const mock = mockFetch([
      { status: 503, body: {}, headers: { "Retry-After": "0" } },
      { body: { data: [gobJob()], meta: { total_pages: 1 } } },
    ])
    capture("stdout")
    const code = await runSearch(baseOpts)
    expect(code).toBe(0)
    expect(mock.urls).toHaveLength(2)
  })
})

describe("runDetail", () => {
  test("finds the job among the company's published jobs", async () => {
    const mock = mockFetch([{ body: { data: [gobJob({ id: "other" }), gobJob()], meta: { total_pages: 1 } } }])
    const out = capture("stdout")
    const code = await runDetail({ id: "acme/full-stack-software-engineer-acme-lima", format: "json" })
    expect(code).toBe(0)
    expect(new URL(mock.urls[0]).pathname).toBe("/api/v0/companies/acme/jobs")
    const job = JSON.parse(out.get())
    expect(job.isActive).toBe(true)
    expect(job.description).toContain("Construir APIs")
  })

  test("a job missing from the company's list is NOT_FOUND", async () => {
    mockFetch([{ body: { data: [gobJob({ id: "other" })], meta: { total_pages: 1 } } }])
    const err = capture("stderr")
    const code = await runDetail({ id: "acme/gone", format: "json" })
    expect(code).toBe(1)
    expect(JSON.parse(err.get()).code).toBe("NOT_FOUND")
  })

  test("an unparseable id is rejected before any request", async () => {
    const mock = mockFetch([{ body: {} }])
    const err = capture("stderr")
    const code = await runDetail({ id: "just-a-slug", format: "json" })
    expect(code).toBe(1)
    expect(JSON.parse(err.get()).code).toBe("BAD_ID")
    expect(mock.urls).toHaveLength(0)
  })
})
