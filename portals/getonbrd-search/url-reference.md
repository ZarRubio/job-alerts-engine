# Get on Board API reference

The endpoints and response fields this skill depends on - the file to update if
the API changes. OpenAPI spec: `https://www.getonbrd.com/doc/openapi.yaml`
(rendered at `https://www.getonbrd.com/api-doc`). Base URL `https://www.getonbrd.com/api/v0/`.

## Access

The **public API** ("open to anyone; the same data visible on the platform
without logging in: job categories, company profiles, published jobs, and a job
search endpoint") needs no authentication. The private API (company jobs,
applications, processes) needs a company key and is not used. `robots.txt`
allows `/` for `*` (content signal `search=yes`). Verified live 2026-11-12:

| Endpoint | Status |
|----------|--------|
| `GET /api/v0/search/jobs?query=react&country_code=pe` | 200 |
| `GET /api/v0/companies/{company-slug}/jobs` | 200 |
| `GET /api/v0/jobs/{id}` | 401 (private API - not used) |
| `GET /api/v0/search/jobs?country_code=pe&remote=true` | 422 "Localization conflict" |

## `GET /api/v0/search/jobs`

| Param | Notes |
|-------|-------|
| `query` | Free text. Broad match over the whole posting. |
| `country_code` | ISO alpha-2, lower case (`pe`). Country jobs + remote jobs open to it. |
| `remote` | `true` = remote only. Mutually exclusive with `country_code` (422). |
| `per_page` | Max 120; this CLI uses 100. |
| `page` | 1-based. `meta.total_pages` tells when to stop. |
| `expand` | JSON array string: `["company","location_cities","location_tenants","location_regions","seniority"]`. |
| `lang` | `en` / `es` / `pt` - localizes category and country names (the CLI pins `en`). |

There is no date filter and the order is not strictly by date: the CLI filters
`--jobage` and sorts newest-first client-side.

## `GET /api/v0/companies/{company-slug}/jobs`

Same job shape and `expand`/`page`/`per_page` params; used by `detail` because the
public API has no single-job read. The company slug is `attributes.company.data.id`
when `company` is expanded (unexpanded it is a numeric id that this endpoint does not accept).

## Job shape (JSON:API)

```
{ "data": [ { "id": "<job-slug>", "type": "job",
    "attributes": {
      "title", "description_headline", "description" (HTML: requirements),
      "functions_headline", "functions" (HTML: responsibilities),
      "desirable_headline", "desirable", "benefits_headline", "benefits", "projects",
      "remote" (bool), "remote_modality" (fully_remote | remote_local | temporarily_remote | hybrid | no_remote),
      "countries" (["Peru"] or ["Remote"]), "category_name", "min_salary", "max_salary" (USD/month),
      "published_at" (Unix seconds), "lang",
      "company": {"data": {"id": "<company-slug>", "attributes": {"name"}}},
      "seniority": {"data": {"attributes": {"name"}}},
      "location_cities": {"data": [{"attributes": {"name": "Lima", "country": "Peru"}}]},
      "location_tenants": {"data": [{"attributes": {"name": "Peru"}}]},   // countries a remote hire may live in
      "location_regions": {"data": [{"attributes": {"name": "South America"}}]}
    },
    "links": {"public_url": "https://www.getonbrd.com/jobs/<job-slug>"} } ],
  "meta": {"page", "per_page", "total_pages"} }
```

## Mapping to the contract

| Contract | Source |
|----------|--------|
| `id` | `<company.data.id>/<job id>` |
| `title` | `attributes.title` |
| `company` | `attributes.company.data.attributes.name` |
| `location` | mode label from `remote_modality` + cities, else tenants, else regions, else countries |
| `date` | `published_at` -> `YYYY-MM-DD` |
| `url` | `links.public_url` |
| `description` | headlines + cleaned HTML of functions, description, desirable, benefits, projects |
