---
name: remotive-search
version: 1.0.0
description: >
  Use this skill to search remote job listings on Remotive (remotive.com) through
  its public API - remote software, data, AI, DevOps and product roles worldwide,
  filterable by where candidates may live (Worldwide, LATAM, Americas). Trigger
  phrases: find remote jobs, Remotive jobs, remote developer jobs worldwide, remote
  jobs open to Latin America; buscar trabajo remoto en Remotive, empleos remotos
  para Latinoamérica, trabajo remoto de desarrollador.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/remotive-search/cli/src/cli.ts *)
---

# Remotive Search Skill

Searches **[Remotive](https://remotive.com)**'s remote job board through its
public API (`https://remotive.com/api/remote-jobs`, documented in the
`remotive-io/remote-jobs-api` repository). No key, zero runtime dependencies.

## ⚠️ Remotive's API terms - read before running

The API returns a legal notice with every response. This skill complies by design:

- **Attribution:** link back to the Remotive job URL **and** mention Remotive as the
  source. Every result keeps Remotive's `url` and carries `source: "Remotive"`;
  table/plain output ends with a source line.
- **Request volume:** Remotive advises **at most 4 requests a day** and blocks more
  than 2 per minute. Each `search` or `detail` is exactly one request; filtering
  (`--jobage`, `--location`, paging) is client-side. Prefer one category-wide
  search a run (no `--query`) over one search per keyword.
- Listings are delayed 24 hours - use `--jobage` of at least 2.
- Do not republish the jobs on other job sites (personal use only).

Note: remotive.com's `robots.txt` disallows `/api/*` for crawlers; the API itself
is published for developers with the terms above, which is what this skill follows.

## Commands

```bash
bun run .agents/skills/remotive-search/cli/src/cli.ts search [-q "<keywords>"] [--category <slug>] [flags]
bun run .agents/skills/remotive-search/cli/src/cli.ts detail <id|remotive.com URL> [--category <slug>]
```

| Flag | Meaning |
|------|---------|
| `--query`, `-q` | Remotive's `search` (partial match on title + description). Optional. |
| `--category` | Category slug: `software-development`, `artificial-intelligence`, `data`, `devops`, `qa`, ... |
| `--company` | Company name, partial match. |
| `--location`, `-l` | Client-side: `candidate_required_location` contains any term (comma = OR), e.g. `worldwide,latam,americas,peru`. |
| `--jobage <days>` | Published within N days (client-side). |
| `--page`, `--limit`, `-n` | Client-side paging of the filtered list (default page 1, 25 per page). |
| `--format` | `json` (default), `table`, `plain`. |

`detail` has no dedicated endpoint: it makes the same single list request and
picks the id. Search results already include the full description.

## Examples

```bash
# The whole software-development category, last 4 days, open to LatAm or worldwide (1 request)
bun run .agents/skills/remotive-search/cli/src/cli.ts search --category software-development --jobage 4 --location "worldwide,latam,americas,peru" --format table

# AI roles (a second request - mind the 4-a-day guidance)
bun run .agents/skills/remotive-search/cli/src/cli.ts search --category artificial-intelligence --jobage 7 --format table

# Keyword search
bun run .agents/skills/remotive-search/cli/src/cli.ts search -q "next.js" --format plain
```

## Output

| Field | Notes |
|-------|-------|
| `id` | Remotive numeric id. |
| `title`, `company` | |
| `location` | `Remote · <candidate_required_location>` (e.g. `Remote · LATAM, Europe`). |
| `date` | Publication date, `YYYY-MM-DD`. |
| `url` | The Remotive job page (required link-back). |
| `source` | Always `Remotive`. |
| `candidate_required_location`, `category`, `job_type`, `salary`, `tags` | Extra facets. |
| `description` | Full posting text, cleaned from HTML. |

Errors go to stderr as `{"error": "...", "code": "..."}` with exit code 1.
