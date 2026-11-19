# remotive-cli

CLI for [Remotive](https://remotive.com)'s public remote-jobs API.

**Data source**: `GET /api/remote-jobs` (one request per command).
**Authentication**: none.
**Dependencies**: none at runtime (plain `bun` + `fetch`); `bun install` only pulls dev types.
**Terms**: link back to Remotive and name it as source (built in); at most ~4 requests a day.

```bash
cd portals/remotive-search/cli
bun install          # optional - TypeScript dev types
bun run src/cli.ts search --category software-development --jobage 4 --format table
bun run typecheck
bun test             # network-free fixtures - never call the live API from tests
```

See `../SKILL.md` for flags and `../url-reference.md` for the API notes.
