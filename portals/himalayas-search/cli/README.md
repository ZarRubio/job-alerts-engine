# himalayas-cli

CLI for the [Himalayas](https://himalayas.app) public Remote Jobs API.

**Data source**: `GET /jobs/api/search`, `GET /jobs/api/companies/{company}/jobs/{slug}`.
**Authentication**: none required; optional `HIMALAYAS_API_TOKEN` (environment only) raises the rate limit.
**Dependencies**: none at runtime (plain `bun` + `fetch`); `bun install` only pulls dev types.
**Terms**: results keep the API's `applicationLink` and name Himalayas as source; personal use only.

```bash
cd portals/himalayas-search/cli
bun install          # optional - TypeScript dev types
bun run src/cli.ts search -q "full stack" --country Peru --jobage 3 --format table
bun run src/cli.ts detail onfleet/full-stack-engineer --format plain
bun run typecheck
bun test             # network-free fixtures
```

See `../SKILL.md` for flags and `../url-reference.md` for the API notes.
