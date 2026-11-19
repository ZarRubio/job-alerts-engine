import { afterEach, describe, expect, test } from "bun:test"
import { runSearch, type SearchOpts } from "../src/commands/search"
import { runDetail } from "../src/commands/detail"
import { cleanHtml, matchesAny, parseJobId, toResult, type RemotiveJob } from "../src/helpers"

// Network-free: fetch is stubbed with fixtures shaped like the live
// /api/remote-jobs response (verified against the real endpoint).

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

function rjob(overrides: Partial<RemotiveJob> = {}): RemotiveJob {
  return {
    id: 2091170,
    url: "https://remotive.com/remote-jobs/software-dev/full-stack-developer-2091170",
    title: "Full-Stack Developer",
    company_name: "Acme",
    category: "Software Development",
    tags: ["react", "node"],
    job_type: "full_time",
    publication_date: "2026-11-10T09:11:58",
    candidate_required_location: "Worldwide",
    salary: "",
    description: "<p>Build with <strong>React</strong> &amp; Node.js</p><ul><li>TypeScript</li></ul>",
    ...overrides,
  }
}

function mockFetch(responses: Array<{ status?: number; body: unknown }>): { urls: string[] } {
  const urls: string[] = []
  let i = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const r = responses[Math.min(i++, responses.length - 1)]
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  return { urls }
}

const NOW = Date.parse("2026-11-12T12:00:00Z")
const baseOpts: SearchOpts = { locations: [], jobage: 9999, page: 1, limit: 25, format: "json", now: NOW }

describe("toResult", () => {
  test("keeps the Remotive URL, names the source and leads the location with Remote", () => {
    const r = toResult(rjob())
    expect(r.id).toBe("2091170")
    expect(r.url).toBe("https://remotive.com/remote-jobs/software-dev/full-stack-developer-2091170")
    expect(r.source).toBe("Remotive")
    expect(r.location).toBe("Remote · Worldwide")
    expect(r.date).toBe("2026-11-10")
    expect(r.salary).toBeNull()
    expect(r.description).toBe("Build with React & Node.js\n- TypeScript")
  })

  test("missing values are null, never omitted", () => {
    const r = toResult(rjob({ company_name: null, publication_date: null, candidate_required_location: null }))
    expect(r.company).toBeNull()
    expect(r.date).toBeNull()
    expect(r.location).toBe("Remote")
    expect(r.candidate_required_location).toBeNull()
  })
})

describe("helpers", () => {
  test("parseJobId reads ids and remotive URLs only", () => {
    expect(parseJobId("2091170")).toBe("2091170")
    expect(parseJobId("https://remotive.com/remote-jobs/software-dev/full-stack-developer-2091170")).toBe("2091170")
    expect(parseJobId("https://evil.example.com/remote-jobs/x-2091170")).toBeNull()
    expect(parseJobId("abc")).toBeNull()
  })

  test("matchesAny is a case-insensitive OR over substrings", () => {
    expect(matchesAny("LATAM, Europe", ["latam"])).toBe(true)
    expect(matchesAny("USA", ["worldwide", "latam"])).toBe(false)
    expect(matchesAny(null, [])).toBe(true)
    expect(cleanHtml(null)).toBeNull()
  })
})

describe("runSearch", () => {
  test("makes exactly one request with category/search params and filters client-side", async () => {
    const mock = mockFetch([
      {
        body: {
          "job-count": 4,
          jobs: [
            rjob({ id: 1, publication_date: "2026-11-11T00:00:00", candidate_required_location: "USA" }),
            rjob({ id: 2, publication_date: "2026-11-11T00:00:00", candidate_required_location: "LATAM, Europe" }),
            rjob({ id: 3, publication_date: "2026-10-01T00:00:00", candidate_required_location: "Worldwide" }),
            rjob({ id: 4, publication_date: "2026-11-09T00:00:00", candidate_required_location: "Worldwide" }),
          ],
        },
      },
    ])
    const out = capture("stdout")
    const code = await runSearch({ ...baseOpts, category: "software-dev", query: "react", jobage: 7, locations: ["worldwide", "latam"] })
    expect(code).toBe(0)
    expect(mock.urls).toHaveLength(1)
    const params = new URL(mock.urls[0]).searchParams
    expect(params.get("category")).toBe("software-dev")
    expect(params.get("search")).toBe("react")
    expect(params.has("limit")).toBe(false)
    const parsed = JSON.parse(out.get())
    expect(parsed.results.map((r: { id: string }) => r.id)).toEqual(["2", "4"])
    expect(parsed.meta.source).toBe("Remotive")
  })

  test("--page and --limit page the filtered list", async () => {
    mockFetch([{ body: { jobs: [1, 2, 3].map((id) => rjob({ id, publication_date: `2026-11-0${id}T00:00:00` })) } }])
    const out = capture("stdout")
    await runSearch({ ...baseOpts, page: 2, limit: 2 })
    expect(JSON.parse(out.get()).results.map((r: { id: string }) => r.id)).toEqual(["1"])
  })

  test("an HTTP error is a JSON error on stderr with exit 1", async () => {
    mockFetch([{ status: 403, body: {} }])
    const err = capture("stderr")
    expect(await runSearch(baseOpts)).toBe(1)
    expect(JSON.parse(err.get()).code).toBe("SEARCH_FAILED")
  })
})

describe("runDetail", () => {
  test("finds the job in the single list request", async () => {
    const mock = mockFetch([{ body: { jobs: [rjob({ id: 5 }), rjob()] } }])
    const out = capture("stdout")
    expect(await runDetail({ id: "2091170", category: "software-dev", format: "json" })).toBe(0)
    expect(mock.urls).toHaveLength(1)
    expect(JSON.parse(out.get()).isActive).toBe(true)
  })

  test("a job no longer listed is NOT_FOUND", async () => {
    mockFetch([{ body: { jobs: [rjob({ id: 5 })] } }])
    const err = capture("stderr")
    expect(await runDetail({ id: "999", format: "json" })).toBe(1)
    expect(JSON.parse(err.get()).code).toBe("NOT_FOUND")
  })
})
