#!/usr/bin/env bun
// Self-contained CLI for Remotive's public remote-jobs API. Zero runtime
// dependencies. One API request per command - Remotive advises a few calls a
// day at most, so this CLI is built to be called rarely and filter client-side.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { writeError } from "./helpers.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

const ALIAS: Record<string, string> = { q: "query", n: "limit", l: "location" }
const BOOLEAN_FLAGS = new Set(["help", "h"])

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

const HELP = `remotive-cli — search Remotive (remotive.com) remote jobs via its public API

USAGE
  bun run src/cli.ts search [-q "<keywords>"] [--category <slug>] [flags] [--format json|table|plain]
  bun run src/cli.ts detail <id|remotive.com URL> [--category <slug>] [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Remotive's search: partial match on title and description.
                          Optional - omit it to list the whole category in one call.
  --category <slug>       Remotive category slug, e.g. software-development, data, devops,
                          product, design (see remotive.com/api/remote-jobs/categories).
  --company <name>        Company name, partial match.
  --location, -l <terms>  Client-side filter on candidate_required_location; comma = OR,
                          substring, e.g. --location "worldwide,latam,americas,peru".
  --jobage <days>         Published within N days (client-side). Remotive delays
                          listings 24 h, so use at least 2.
  --page <n>              Client-side page of the filtered list. Default 1.
  --limit, -n <n>         Client-side page size. Default 25.
  --format <fmt>          json (default) | table | plain.

TERMS (Remotive's API notice)
  Link back to the Remotive job URL and name Remotive as the source (every result
  carries url + source). Call the API a few times a day at most (Remotive advises
  max 4/day and blocks more than 2 requests/minute); each command is one request.

EXAMPLES
  bun run src/cli.ts search --category software-development --jobage 4 --format table
  bun run src/cli.ts search -q "python" --location "worldwide,latam" --format table
  bun run src/cli.ts detail 2091171 --category software-development --format plain
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "category", "company", "location", "jobage", "page", "limit", "format", "help", "h"]),
  detail: new Set(["category", "format", "help", "h"]),
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

const SLUG = /^[a-z0-9][a-z0-9-]*$/i

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
  for (const name of ["query", "category", "company", "location"]) {
    const v = flags[name]
    if (v !== undefined && (typeof v !== "string" || !v.trim())) return badArg(`--${name} requires a non-empty value`)
  }
  const category = typeof flags.category === "string" ? flags.category.trim() : undefined
  if (category !== undefined && !SLUG.test(category)) return badArg(`--category must be a category slug such as software-development, got "${category}"`)

  if (cmd === "search") {
    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "table", "plain"].includes(fmt)) return badArg(`--format must be one of json|table|plain, got "${fmt}"`)
    const jobage = intFlag("jobage", flags.jobage, 9999)
    const page = intFlag("page", flags.page, 1)
    const limit = intFlag("limit", flags.limit, 25)
    if (jobage === null || page === null || limit === null) return 1
    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query.trim() : undefined,
      category,
      company: typeof flags.company === "string" ? flags.company.trim() : undefined,
      locations:
        typeof flags.location === "string"
          ? flags.location.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
      jobage,
      page,
      limit,
      format: fmt as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  const id = (flags._ as string[])[1]
  if (!id) {
    writeError("detail requires a Remotive job <id|url>", "NO_ID")
    return 1
  }
  const fmt = flags.format !== undefined ? String(flags.format) : "json"
  if (!["json", "plain"].includes(fmt)) return badArg(`--format must be one of json|plain, got "${fmt}"`)
  const opts: DetailOpts = { id, category, format: fmt as DetailOpts["format"] }
  return runDetail(opts)
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    writeError(e instanceof Error ? e.message : String(e), "INTERNAL_ERROR")
    process.exit(1)
  })
