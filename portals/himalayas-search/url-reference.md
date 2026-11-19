# Himalayas Remote Jobs API reference

Docs: `https://himalayas.app/api` and `https://himalayas.app/docs/remote-jobs-api`
(terms: linked "API terms" on those pages). Verified live 2026-11-12.

## Endpoints

| Endpoint | Use |
|----------|-----|
| `GET /jobs/api/search` | Filtered search - used by `search`. 20 jobs per page, `?page=N`, no cursor. |
| `GET /jobs/api/companies/{company}/jobs/{slug}` | Check one job: 200 `{job}` open, 410 closed (body has `expiryDate`), 404 unknown - used by `detail`. |
| `GET /jobs/api` | Unfiltered feed with cursor pagination (max 20) - not used. |

### Search parameters

| Param | Notes |
|-------|-------|
| `q` | Free text. |
| `country` | ISO alpha-2, common names, slugs or abbreviations. Returns jobs open to that country, worldwide ones included. |
| `worldwide` / `exclude_worldwide` | Only worldwide / drop worldwide (with `country`). |
| `seniority` | Comma list: Entry-level, Mid-level, Senior, Manager, Director, Executive (verified comma form works). |
| `employment_type` | Comma list: Full Time, Part Time, Contractor, Temporary, Intern, Volunteer, Other. |
| `timezone` | `-5`, `UTC-5`, `UTC+05:30`. |
| `sort` | relevant, recent, salaryAsc, salaryDesc, nameAToZ, nameZToA, jobs. |
| `page` | 1-based. Every page has 20 jobs except the last; `totalCount` is an estimate. |

## Job shape

```
{ "title", "excerpt", "companyName", "companySlug", "companyLogo", "employmentType",
  "minSalary", "maxSalary", "salaryPeriod", "currency", "seniority": [..],
  "locationRestrictions": ["Peru", ...] (empty = worldwide), "timezoneRestrictions": [-5, ...],
  "categories": [..], "parentCategories": [..], "description" (plain text with \n),
  "pubDate" (Unix s), "expiryDate" (Unix s),
  "applicationLink": "https://himalayas.app/companies/<c>/jobs/<slug>?utm_source=api",
  "guid": "https://himalayas.app/companies/<c>/jobs/<slug>" }
```

## Terms and limits

- Use `applicationLink` unchanged for every Apply button; show Himalayas (job link or
  himalayas.app) as the source; show jobs only on sites/apps you operate; do not pass
  them to other job boards, aggregators, Google Jobs or LinkedIn Jobs; remove expired jobs.
- No key needed. Optional free key (`Authorization: Bearer ...`, env `HIMALAYAS_API_TOKEN`):
  60 requests/min and 10,000/day. Unkeyed requests share one public allowance; responses
  served from cache (`s-maxage=3600`) do not count. A keyed 429 carries `Retry-After`.

## Mapping to the contract

| Contract | Source |
|----------|--------|
| `id` | `<company>/<slug>` parsed from `guid` |
| `title` / `company` | `title` / `companyName` |
| `location` | `Remote · Worldwide` or `Remote · ` + `locationRestrictions` (searched country first, cut after 5) |
| `date` | `pubDate` -> `YYYY-MM-DD` |
| `url` | `applicationLink` (unchanged) |
| `description` | `description`, whitespace-normalised |
