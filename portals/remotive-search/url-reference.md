# Remotive API reference

Source documentation: the `remotive-io/remote-jobs-api` README on GitHub
(`https://remotive.com/api-documentation` redirects there). Verified live 2026-11-12.

## Endpoint

`GET https://remotive.com/api/remote-jobs` - every **active** remote listing,
sorted by publication date (newest first).

| Param | Notes |
|-------|-------|
| `category` | Category name or slug (`software-development` - `software-dev` also works -, `artificial-intelligence`, `data`, `devops`, ...). List: `/api/remote-jobs/categories`. |
| `search` | Partial (`ilike`) match on title and description. |
| `company_name` | Partial match on company name. |
| `limit` | Max results (default all). Not used: the CLI filters client-side after the date/location filters. |

## Response

```
{ "0-legal-notice": "...", "job-count": N, "total-job-count": N,
  "jobs": [ { "id": 2091171, "url": "https://remotive.com/remote-jobs/<category>/<slug>-<id>",
              "title", "company_name", "company_logo", "category", "tags": [...],
              "job_type" (full_time | contract | part_time | freelance | internship, often empty),
              "publication_date": "2026-11-11T09:11:58",
              "candidate_required_location": "USA" | "Worldwide" | "LATAM, Europe" | ...,
              "salary" (free text, optional), "description" (HTML) } ] }
```

## Terms (from the legal notice and README)

- Link back to the Remotive URL and mention Remotive as the source, or API access is terminated.
- Data changes slowly: request "a couple of times a day (max. 4 times a day)"; more than 2 requests/minute are blocked.
- Listings are delayed 24 h. Do not submit the jobs to third-party job sites.
- `robots.txt` disallows `/api/*` (and query-string URLs) for crawlers; the API is
  separately published for developers under the terms above.

## Mapping to the contract

| Contract | Source |
|----------|--------|
| `id` | `id` (string) |
| `title` / `company` | `title` / `company_name` |
| `location` | `"Remote · " + candidate_required_location` |
| `date` | `publication_date[:10]` |
| `url` | `url` (Remotive page - the required link-back) |
| `description` | cleaned `description` HTML |
