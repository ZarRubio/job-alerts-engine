#!/usr/bin/env bun
// Self-contained CLI for Get on Board's public job API (Latin American tech
// jobs: on-site, hybrid and remote). No external CLI framework and zero runtime
// dependencies, so it runs anywhere `bun` is available.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { writeError } from "./helpers.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

const ALIAS: Record<string, string> = { q: "query", n: "limit", l: "country" }

// Flags that never take a value: the next token stays positional.
const BOOLEAN_FLAGS = new Set(["remote", "help", "h"])

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("-") || a === "-") {
      ;(flags._ as string[]).push(a)
      continue
    }
    const key = ALIAS[a.replace(/^-+/, "")] ?? a.replace(/^-+/, "")
    const next = argv[i + 1]
    let value: string | boolean = true
    if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("-")) {
      value = next
      i++
    }
    flags[key] = value
  }
  return flags
}

const HELP = `getonbrd-cli — search Get on Board (getonbrd.com), the Latin American tech job board

USAGE
  bun run src/cli.ts search [-q "<keywords>"] [--country pe | --remote] [flags] [--format json|table|plain]
  bun run src/cli.ts detail <company-slug>/<job-slug> [--format json|plain]
  bun run src/cli.ts detail <job-slug|getonbrd.com URL> --company <company-slug>

SEARCH FLAGS
  --query, -q <text>      Keywords (optional). Without it, every published job for the
                          country/remote filter is listed.
  --country, -l <code>    ISO-3166 alpha-2 country, e.g. pe. Returns that country's jobs
                          plus remote jobs open to it. Cannot be combined with --remote.
  --remote                Remote jobs only (any country). Cannot be combined with --country.
  --category <names>      Client-side filter on the category name, comma = OR, substring,
                          e.g. --category "programming,machine learning,data".
  --jobage <days>         Posted within N days (client-side; the API has no date filter).
  --page <n>              First API page to read (100 jobs per page). Default 1.
  --max-pages <n>         API pages to read from --page on. Default 3.
  --limit, -n <n>         Client-side cap on printed results. Default 25.
  --format <fmt>          json (default) | table | plain.

DETAIL
  The public API has no single-job endpoint, so detail looks the job up among the
  company's published jobs. A search result's id is already <company>/<job>.

EXAMPLES
  bun run src/cli.ts search -q "react" --country pe --jobage 7 --format table
  bun run src/cli.ts search --country pe --category "programming,machine learning" --limit 50
  bun run src/cli.ts search -q "python" --remote --format table
  bun run src/cli.ts detail codeable-pe/analista-de-datos-power-bi-codeable-lima --format plain

Public API, no key. Results link back to getonbrd.com.
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "country", "remote", "category", "jobage", "page", "max-pages", "limit", "format", "help", "h"]),
  detail: new Set(["company", "format", "help", "h"]),
}

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
    for (const name of ["query", "country", "category"]) {
      const v = flags[name]
      if (v !== undefined && (typeof v !== "string" || !v.trim())) return badArg(`--${name} requires a non-empty value`)
    }
    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "table", "plain"].includes(fmt)) return badArg(`--format must be one of json|table|plain, got "${fmt}"`)
    const country = typeof flags.country === "string" ? flags.country.trim().toLowerCase() : undefined
    if (country !== undefined && !/^[a-z]{2}$/.test(country)) return badArg(`--country must be an ISO-3166 alpha-2 code such as pe, got "${flags.country}"`)
    if (country && flags.remote) {
      return badArg("--country and --remote cannot be combined (the API refuses it); --country already includes remote jobs open to that country")
    }
    const jobage = intFlag("jobage", flags.jobage, 9999)
    const page = intFlag("page", flags.page, 1)
    const maxPages = intFlag("max-pages", flags["max-pages"], 3)
    const limit = intFlag("limit", flags.limit, 25)
    if (jobage === null || page === null || maxPages === null || limit === null) return 1
    if (maxPages > 10) return badArg("--max-pages is capped at 10 to keep request volume polite")

    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query.trim() : undefined,
      country,
      remote: flags.remote === true,
      categories:
        typeof flags.category === "string"
          ? flags.category.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
      jobage,
      page,
      maxPages,
      limit,
      format: fmt as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  // detail
  const id = (flags._ as string[])[1]
  if (!id) {
    writeError("detail requires <company-slug>/<job-slug> (or a job slug/URL with --company)", "NO_ID")
    return 1
  }
  const fmt = flags.format !== undefined ? String(flags.format) : "json"
  if (!["json", "plain"].includes(fmt)) return badArg(`--format must be one of json|plain, got "${fmt}"`)
  if (flags.company !== undefined && (typeof flags.company !== "string" || !flags.company.trim())) {
    return badArg("--company requires a non-empty value")
  }
  const opts: DetailOpts = {
    id,
    company: typeof flags.company === "string" ? flags.company : undefined,
    format: fmt as DetailOpts["format"],
  }
  return runDetail(opts)
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    writeError(e instanceof Error ? e.message : String(e), "INTERNAL_ERROR")
    process.exit(1)
  })
