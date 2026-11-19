---
name: getonbrd-search
version: 1.0.0
description: >
  Use this skill to search live tech job listings on Get on Board (getonbrd.com),
  the Latin American tech job board - on-site and hybrid jobs in a given country
  (e.g. Peru / Lima) plus remote jobs open to it - or to look up one posting.
  Trigger phrases: find tech jobs in Peru, Get on Board jobs, LatAm developer jobs,
  remote jobs for Latin America; buscar empleo en Get on Board, ofertas de
  desarrollador en Lima, trabajos remotos para Latinoamérica, empleos tech en Perú.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/getonbrd-search/cli/src/cli.ts *)
---

# Get on Board Search Skill

Searches **[Get on Board](https://www.getonbrd.com)**, a tech recruitment
platform focused on Latin America, through its **public API v0** (documented at
`https://www.getonbrd.com/api-doc`). No authentication, no API key, **zero runtime
dependencies** - it runs with just `bun`. `robots.txt` allows the API path.

- `--country pe` returns the jobs located in Peru (on-site/hybrid, mostly Lima)
  **plus remote jobs that accept candidates from Peru** - the one filter a Lima
  candidate needs.
- Every search result already carries the full posting text (functions,
  requirements, nice-to-haves, benefits), so `detail` is rarely needed.

## Commands

### Search

```bash
bun run .agents/skills/getonbrd-search/cli/src/cli.ts search [-q "<keywords>"] [--country pe | --remote] [flags]
```

| Flag | Meaning |
|------|---------|
| `--query`, `-q` | Keywords (optional). Without it, every published job for the country/remote filter is listed. |
| `--country`, `-l` | ISO-3166 alpha-2 code (`pe`). Country jobs + remote jobs open to it. Cannot be combined with `--remote` (the API answers 422). |
| `--remote` | Remote jobs only, any country. |
| `--category` | Client-side filter on the category name, comma = OR, substring (`programming,machine learning,data`). |
| `--jobage <days>` | Posted within N days (client-side - the API has no date filter). |
| `--page <n>` / `--max-pages <n>` | First API page (100 jobs each) and how many to read. Defaults 1 / 3 (max 10). |
| `--limit`, `-n` | Client-side cap on printed results (default 25). |
| `--format` | `json` (default), `table`, `plain`. |

### Detail

```bash
bun run .agents/skills/getonbrd-search/cli/src/cli.ts detail <company-slug>/<job-slug> [--format json|plain]
bun run .agents/skills/getonbrd-search/cli/src/cli.ts detail <job-slug|getonbrd.com URL> --company <company-slug>
```

The public API has no single-job endpoint (`/api/v0/jobs/{id}` is the private,
company-authenticated one), so `detail` finds the job among the company's published
jobs. A search result's `id` is already `<company-slug>/<job-slug>`.

## Examples

```bash
# Recent React jobs in Peru or remote-for-Peru
bun run .agents/skills/getonbrd-search/cli/src/cli.ts search -q "react" --country pe --jobage 7 --format table

# Everything in programming / AI / data for Peru in the last 3 days (2 requests)
bun run .agents/skills/getonbrd-search/cli/src/cli.ts search --country pe --category "programming,machine learning,data" --jobage 3 --limit 60

# Remote Python jobs anywhere in LatAm
bun run .agents/skills/getonbrd-search/cli/src/cli.ts search -q "python" --remote --format table

# Analista de datos en Lima
bun run .agents/skills/getonbrd-search/cli/src/cli.ts search -q "power bi" --country pe --format plain

# One posting
bun run .agents/skills/getonbrd-search/cli/src/cli.ts detail codeable-pe/analista-de-datos-power-bi-codeable-lima --format plain
```

## Output

| Field | Notes |
|-------|-------|
| `id` | `<company-slug>/<job-slug>` - what `detail` consumes. |
| `title`, `company` | Company name comes from the expanded company resource. |
| `location` | Work mode + place, e.g. `Hybrid · Lima, Peru`, `Remote · Peru, Chile, Mexico`, `Remote (anywhere)`, `On-site · Lima, Peru`. |
| `date` | Publication date, `YYYY-MM-DD`. |
| `url` | The public getonbrd.com job page. |
| `remote_modality`, `seniority`, `category`, `salary` | Extra facets (`salary` is the posted monthly range in USD when given). |
| `description` | Full posting text, cleaned to plain text. |

Errors go to stderr as `{"error": "...", "code": "..."}` with exit code 1.

## Notes

- The API's `query` is a broad full-text search (a `react` query can match a
  sales posting that mentions React somewhere); pair it with `--category` or rely
  on downstream scoring.
- `country_code` and `remote` cannot be combined - `--country pe` already
  includes remote jobs that accept Peru.
- Request volume: a search reads at most `--max-pages` pages of 100 jobs. The
  whole Peru feed is about 200 jobs, so `--country pe --max-pages 3` without a
  query covers it in two requests.
