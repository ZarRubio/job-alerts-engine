import { afterEach, describe, expect, test } from "bun:test"
import { runSearch, type SearchOpts } from "../src/commands/search"
import { runDetail } from "../src/commands/detail"
import { idFromGuid, locationLine, parseJobRef, toResult, type HimalayasJob } from "../src/helpers"

// Network-free: fetch is stubbed with fixtures shaped like the live
// /jobs/api/search response (verified against the real endpoint).

const originalFetch = globalThis.fetch
const originalStdoutWrite = process.stdout.write
const originalStderrWrite = process.stderr.write
const originalToken = process.env.HIMALAYAS_API_TOKEN

afterEach(() => {
  globalThis.fetch = originalFetch
  process.stdout.write = originalStdoutWrite
  process.stderr.write = originalStderrWrite
  if (originalToken === undefined) delete process.env.HIMALAYAS_API_TOKEN
  else process.env.HIMALAYAS_API_TOKEN = originalToken
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

function hjob(slug = "full-stack-engineer", overrides: Partial<HimalayasJob> = {}): HimalayasJob {
  return {
    title: "Full-Stack Engineer",
    companyName: "Onfleet",
    companySlug: "onfleet",
    employmentType: "Full Time",
    minSalary: null,
    maxSalary: null,
    seniority: ["Mid-level"],
    locationRestrictions: ["Argentina", "Brazil", "Chile", "Colombia", "Mexico", "Peru", "Uruguay"],
    timezoneRestrictions: [-8, -5],
    description: " Build React apps. \n\n\n\n Node.js and TypeScript. ",
    pubDate: day("2026-11-11"),
    applicationLink: `https://himalayas.app/companies/onfleet/jobs/${slug}?utm_source=api`,
    guid: `https://himalayas.app/companies/onfleet/jobs/${slug}`,
    ...overrides,
  }
}

function mockFetch(responses: Array<{ status?: number; body: unknown }>): { urls: string[]; headers: Headers[] } {
  const urls: string[] = []
  const headers: Headers[] = []
  let i = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    headers.push(new Headers(init?.headers))
    const r = responses[Math.min(i++, responses.length - 1)]
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  return { urls, headers }
}

const baseOpts: SearchOpts = {
  worldwide: false,
  excludeWorldwide: false,
  seniority: [],
  employmentType: [],
  sort: "recent",
  jobage: 9999,
  page: 1,
  maxPages: 1,
  limit: 20,
  format: "json",
  now: NOW,
}

describe("toResult", () => {
  test("uses the applicationLink unchanged, names the source, lists the searched country first", () => {
    const r = toResult(hjob(), "Peru")
    expect(r.id).toBe("onfleet/full-stack-engineer")
    expect(r.url).toBe("https://himalayas.app/companies/onfleet/jobs/full-stack-engineer?utm_source=api")
    expect(r.source).toBe("Himalayas")
    expect(r.location).toBe("Remote · Peru, Argentina, Brazil, Chile, Colombia +2")
    expect(r.date).toBe("2026-11-11")
    expect(r.description).toBe("Build React apps.\n\nNode.js and TypeScript.")
  })

  test("no restriction reads as worldwide; missing values are null", () => {
    expect(locationLine([])).toBe("Remote · Worldwide")
    const r = toResult(hjob("x", { companyName: null, pubDate: null }))
    expect(r.company).toBeNull()
    expect(r.date).toBeNull()
    expect(r.salary).toBeNull()
  })

  test("idFromGuid and parseJobRef", () => {
    expect(idFromGuid("https://himalayas.app/companies/linear/jobs/senior-product-engineer")).toBe("linear/senior-product-engineer")
    expect(parseJobRef("linear/senior-product-engineer")).toEqual({ company: "linear", slug: "senior-product-engineer" })
    expect(parseJobRef("https://himalayas.app/companies/linear/jobs/x?utm_source=api")).toEqual({ company: "linear", slug: "x" })
    expect(parseJobRef("https://evil.example.com/companies/linear/jobs/x")).toBeNull()
    expect(parseJobRef("just-a-slug")).toBeNull()
  })
})

describe("runSearch", () => {
  test("sends q/country/seniority/sort and filters by age", async () => {
    const mock = mockFetch([{ body: { jobs: [hjob("a"), hjob("b", { pubDate: day("2026-10-01") })] } }])
    const out = capture("stdout")
    const code = await runSearch({ ...baseOpts, query: "react", country: "Peru", seniority: ["Entry-level", "Mid-level"], jobage: 3 })
    expect(code).toBe(0)
    const params = new URL(mock.urls[0]).searchParams
    expect(params.get("q")).toBe("react")
    expect(params.get("country")).toBe("Peru")
    expect(params.get("seniority")).toBe("Entry-level,Mid-level")
    expect(params.get("sort")).toBe("recent")
    expect(mock.headers[0].get("authorization")).toBeNull()
    const parsed = JSON.parse(out.get())
    expect(parsed.results.map((r: { id: string }) => r.id)).toEqual(["onfleet/a"])
    expect(parsed.meta.source).toBe("Himalayas")
  })

  test("reads further pages only while pages are full and still recent", async () => {
    const full = Array.from({ length: 20 }, (_, i) => hjob(`p1-${i}`))
    const mock = mockFetch([{ body: { jobs: full } }, { body: { jobs: [hjob("p2-0")] } }, { body: { jobs: [hjob("never")] } }])
    const out = capture("stdout")
    await runSearch({ ...baseOpts, maxPages: 3, limit: 100 })
    expect(mock.urls).toHaveLength(2)
    expect(JSON.parse(out.get()).results).toHaveLength(21)
  })

  test("the optional token travels only in the Authorization header", async () => {
    process.env.HIMALAYAS_API_TOKEN = "test-token-value"
    const mock = mockFetch([{ body: { jobs: [] } }])
    capture("stdout")
    await runSearch(baseOpts)
    expect(mock.headers[0].get("authorization")).toBe("Bearer test-token-value")
    expect(mock.urls[0]).not.toContain("test-token-value")
  })

  test("an HTTP error is a JSON error on stderr with exit 1", async () => {
    mockFetch([{ status: 400, body: {} }])
    const err = capture("stderr")
    expect(await runSearch(baseOpts)).toBe(1)
    expect(JSON.parse(err.get()).code).toBe("SEARCH_FAILED")
  })
})

describe("runDetail", () => {
  test("an open job prints in full with isActive true", async () => {
    const mock = mockFetch([{ body: { job: hjob() } }])
    const out = capture("stdout")
    expect(await runDetail({ id: "onfleet/full-stack-engineer", format: "json" })).toBe(0)
    expect(new URL(mock.urls[0]).pathname).toBe("/jobs/api/companies/onfleet/jobs/full-stack-engineer")
    expect(JSON.parse(out.get()).isActive).toBe(true)
  })

  test("a closed job (410) reports isActive false", async () => {
    mockFetch([{ status: 410, body: { expiryDate: 1799686995 } }])
    const out = capture("stdout")
    expect(await runDetail({ id: "onfleet/full-stack-engineer", format: "json" })).toBe(0)
    expect(JSON.parse(out.get()).isActive).toBe(false)
  })

  test("a 404 is NOT_FOUND", async () => {
    mockFetch([{ status: 404, body: {} }])
    const err = capture("stderr")
    expect(await runDetail({ id: "onfleet/nope", format: "json" })).toBe(1)
    expect(JSON.parse(err.get()).code).toBe("NOT_FOUND")
  })
})
