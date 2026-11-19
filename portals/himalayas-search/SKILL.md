---
name: himalayas-search
version: 1.0.0
description: >
  Use this skill to search remote job listings on Himalayas (himalayas.app) through
  its public JSON API, filtered to jobs a resident of a given country (e.g. Peru)
  may take, by keyword, seniority and timezone - or to check whether a Himalayas
  posting is still open. Trigger phrases: find remote jobs open to Peru, Himalayas
  jobs, remote developer jobs for Latin America, worldwide remote jobs; buscar
  trabajo remoto desde Perú, empleos remotos en Himalayas, trabajo remoto para
  Latinoamérica.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/himalayas-search/cli/src/cli.ts *)
---

# Himalayas Search Skill

Searches **[Himalayas](https://himalayas.app)**, a remote-jobs board, through its
free public **Remote Jobs API** (documented at `https://himalayas.app/api` and
`https://himalayas.app/docs/remote-jobs-api`). No key required; zero runtime
dependencies. `robots.txt` allows the API path.

The key filter is `--country`: Himalayas records which countries each remote job
accepts, so `--country Peru` returns only jobs a Peru resident may take (plus
worldwide ones, unless `--exclude-worldwide`).

## API terms (built in)

- Every result's `url` is the API's `applicationLink`, **unchanged** (required for
  every Apply action), and every result carries `source: "Himalayas"`.
- Personal use: do not pass the jobs on to other job boards or aggregators.
- Closed jobs must be dropped: `detail` reports a closed job (HTTP 410) as
  `isActive: false`.
- Rate limits: requests without a key share a public allowance; cached responses
  do not count. An optional free key raises the limit to 60/min - export it as
  `HIMALAYAS_API_TOKEN` (environment only; never a flag, never committed). A
  401 means the key is invalid: fix or unset it.

## Commands

```bash
bun run .agents/skills/himalayas-search/cli/src/cli.ts search [-q "<keywords>"] [--country <code|name>] [flags]
bun run .agents/skills/himalayas-search/cli/src/cli.ts detail <company>/<slug>|<himalayas.app job URL>
```

| Flag | Meaning |
|------|---------|
| `--query`, `-q` | Free text, e.g. `"react engineer"`. |
| `--country`, `-l` | ISO alpha-2 or name (`PE`, `Peru`). Jobs open to that country; with a name, that country is listed first in `location`. |
| `--worldwide` / `--exclude-worldwide` | Only worldwide jobs / with `--country`, drop worldwide jobs. |
| `--seniority` | Comma list of `Entry-level`, `Mid-level`, `Senior`, `Manager`, `Director`, `Executive`. |
| `--employment-type` | Comma list: `Full Time`, `Part Time`, `Contractor`, ... |
| `--timezone` | e.g. `-5` or `UTC-5`. |
| `--sort` | `recent` (default), `relevant`, `salaryDesc`, ... |
| `--jobage <days>` | Published within N days (client-side). |
| `--page`, `--max-pages` | First API page (20 jobs each) and pages to read (default 1, max 5). |
| `--limit`, `-n` | Client-side cap (default 20). |
| `--format` | `json` (default), `table`, `plain`. |

## Examples

```bash
# Full-stack roles open to Peru, last 3 days, not senior
bun run .agents/skills/himalayas-search/cli/src/cli.ts search -q "full stack" --country Peru --seniority Entry-level,Mid-level --jobage 3 --format table

# AI engineering open to Peru
bun run .agents/skills/himalayas-search/cli/src/cli.ts search -q "AI engineer" --country Peru --format table

# Lima-timezone-friendly Python jobs
bun run .agents/skills/himalayas-search/cli/src/cli.ts search -q "python" --timezone -5 --format plain

# Is this posting still open?
bun run .agents/skills/himalayas-search/cli/src/cli.ts detail onfleet/full-stack-engineer --format plain
```

## Output

| Field | Notes |
|-------|-------|
| `id` | `<company-slug>/<job-slug>` - what `detail` consumes. |
| `title`, `company` | |
| `location` | `Remote · Worldwide` or `Remote · Peru, Argentina, ... +N`. |
| `date` | Publication date, `YYYY-MM-DD`. |
| `url` | The API's `applicationLink`, unchanged. |
| `source` | Always `Himalayas`. |
| `location_restrictions`, `timezone_restrictions`, `seniority`, `employment_type`, `salary` | Extra facets. |
| `description` | Full posting text. |

Errors go to stderr as `{"error": "...", "code": "..."}` with exit code 1.

## Notes

- `q` is loose (a `python` query can return a support role); rely on downstream scoring.
- Search pages hold 20 jobs; `totalCount` is an estimate, so paging stops at the
  first short page (or, with `--sort recent`, once a page is older than `--jobage`).
