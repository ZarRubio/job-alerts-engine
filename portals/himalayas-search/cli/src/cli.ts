#!/usr/bin/env bun
// Self-contained CLI for the Himalayas public Remote Jobs API. Zero runtime
// dependencies. No API key needed; HIMALAYAS_API_TOKEN (optional, environment
// only) raises the rate limit.

import { runSearch, SORTS, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { writeError } from "./helpers.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

const ALIAS: Record<string, string> = { q: "query", n: "limit", l: "country" }
const BOOLEAN_FLAGS = new Set(["worldwide", "exclude-worldwide", "help", "h"])

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("-") || a === "-" || /^-\d/.test(a)) {
      ;(flags._ as string[]).push(a)
      continue
    }
    const key = ALIAS[a.replace(/^-+/, "")] ?? a.replace(/^-+/, "")
    const next = argv[i + 1]
    let value: string | boolean = true
    // A timezone such as -5 is a value, not a flag.
    if (!BOOLEAN_FLAGS.has(key) && next !== undefined && (!next.startsWith("-") || /^-\d/.test(next))) {
      value = next
      i++
    }
    flags[key] = value
  }
  return flags
}

const HELP = `himalayas-cli — search Himalayas (himalayas.app) remote jobs via its public JSON API

USAGE
  bun run src/cli.ts search [-q "<keywords>"] [--country <code|name>] [flags] [--format json|table|plain]
  bun run src/cli.ts detail <company>/<slug>|<himalayas.app job URL> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>         Free-text query, e.g. "react engineer".
  --country, -l <c>          Jobs a resident of this country may take: ISO alpha-2 or a
                             name, e.g. Peru. Includes worldwide jobs unless
                             --exclude-worldwide. The country is listed first in location.
  --worldwide                Only worldwide-friendly jobs.
  --exclude-worldwide        With --country: drop worldwide jobs.
  --seniority <list>         Comma list: Entry-level, Mid-level, Senior, Manager, Director, Executive.
  --employment-type <list>   Comma list: Full Time, Part Time, Contractor, Temporary, Intern, ...
  --timezone <tz>            e.g. -5 or UTC-5.
  --sort <order>             ${SORTS.join(" | ")}. Default recent.
  --jobage <days>            Published within N days (client-side, on pubDate).
  --page <n>                 First API page (20 jobs per page). Default 1.
  --max-pages <n>            API pages to read from --page on. Default 1, max 5.
  --limit, -n <n>            Client-side cap on printed results. Default 20.
  --format <fmt>             json (default) | table | plain.

DETAIL
  Checks one job: open jobs print in full; a closed job (HTTP 410) prints
  isActive: false.

TERMS
  Every result's url is the API's applicationLink, unchanged, and every result
  names Himalayas as its source. Personal use only: do not republish the jobs.

EXAMPLES
  bun run src/cli.ts search -q "full stack" --country Peru --jobage 3 --format table
  bun run src/cli.ts search -q "AI engineer" --country PE --seniority Entry-level,Mid-level
  bun run src/cli.ts detail onfleet/full-stack-engineer --format plain
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set([
    "query", "country", "worldwide", "exclude-worldwide", "seniority", "employment-type", "timezone",
    "sort", "jobage", "page", "max-pages", "limit", "format", "help", "h",
  ]),
  detail: new Set(["format", "help", "h"]),
}

const SENIORITIES = ["Entry-level", "Mid-level", "Senior", "Manager", "Director", "Executive"]

function badArg(message: string): number {
  writeError(message, "BAD_ARG")
  return 1
}

function intFlag(name: string, raw: string | boolean | string[] | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback
  const val = typeof raw === "string" ? Number(raw.trim()) : NaN
  if (!Number.isInteger(val) || val < 1) {
    badArg(`--${name} must be a whole number of at least 1, got "${raw}"`)
    return null
  }
  return val
}

function list(raw: string | boolean | string[] | undefined): string[] {
  return typeof raw === "string" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : []
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2))
  const cmd = (flags._ as string[])[0]

  if (!cmd || flags.help || flags.h) {
    process.stdout.write(HELP)
    return cmd ? 0 : 1
  }
  const known = KNOWN_FLAGS[cmd]
  if (!known) {
    writeError(`Unknown command "${cmd}"`, "BAD_CMD")
    return 1
  }
  for (const key of Object.keys(flags)) {
    if (key === "_" || known.has(key)) continue
    writeError(
      `unknown flag --${key} for '${cmd}' - flags are never silently ignored, because a discarded filter changes what the search returns; see --help`,
      "UNKNOWN_FLAG",
    )
    return 1
  }

  if (cmd === "search") {
    for (const name of ["query", "country", "seniority", "employment-type", "timezone", "sort"]) {
      const v = flags[name]
      if (v !== undefined && (typeof v !== "string" || !v.trim())) return badArg(`--${name} requires a non-empty value`)
    }
    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "table", "plain"].includes(fmt)) return badArg(`--format must be one of json|table|plain, got "${fmt}"`)
    const sort = typeof flags.sort === "string" ? flags.sort.trim() : "recent"
    if (!SORTS.includes(sort)) return badArg(`--sort must be one of ${SORTS.join("|")}, got "${sort}"`)
    const seniority = list(flags.seniority)
    const bad = seniority.find((s) => !SENIORITIES.includes(s))
    if (bad) return badArg(`--seniority values must be among ${SENIORITIES.join(", ")}, got "${bad}"`)
    if (flags.worldwide && flags["exclude-worldwide"]) return badArg("--worldwide and --exclude-worldwide contradict each other")
    if (flags["exclude-worldwide"] && flags.country === undefined) return badArg("--exclude-worldwide only applies with --country")
    const jobage = intFlag("jobage", flags.jobage, 9999)
    const page = intFlag("page", flags.page, 1)
    const maxPages = intFlag("max-pages", flags["max-pages"], 1)
    const limit = intFlag("limit", flags.limit, 20)
    if (jobage === null || page === null || maxPages === null || limit === null) return 1
    if (maxPages > 5) return badArg("--max-pages is capped at 5 to stay within the public rate limit")

    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query.trim() : undefined,
      country: typeof flags.country === "string" ? flags.country.trim() : undefined,
      worldwide: flags.worldwide === true,
      excludeWorldwide: flags["exclude-worldwide"] === true,
      seniority,
      employmentType: list(flags["employment-type"]),
      timezone: typeof flags.timezone === "string" ? flags.timezone.trim() : undefined,
      sort,
      jobage,
      page,
      maxPages,
      limit,
      format: fmt as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  const id = (flags._ as string[])[1]
  if (!id) {
    writeError("detail requires <company>/<slug> or a himalayas.app job URL", "NO_ID")
    return 1
  }
  const fmt = flags.format !== undefined ? String(flags.format) : "json"
  if (!["json", "plain"].includes(fmt)) return badArg(`--format must be one of json|plain, got "${fmt}"`)
  const opts: DetailOpts = { id, format: fmt as DetailOpts["format"] }
  return runDetail(opts)
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    writeError(e instanceof Error ? e.message : String(e), "INTERNAL_ERROR")
    process.exit(1)
  })
