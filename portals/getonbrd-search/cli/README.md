# getonbrd-cli

CLI for searching [Get on Board](https://www.getonbrd.com), the Latin American
tech job board, through its public API v0.

**Data source**: `GET /api/v0/search/jobs`, `GET /api/v0/companies/{slug}/jobs`.
**Authentication**: none (public API).
**Dependencies**: none at runtime (plain `bun` + `fetch`); `bun install` only pulls dev types.

```bash
cd portals/getonbrd-search/cli
bun install          # optional - TypeScript dev types
bun run src/cli.ts search -q "react" --country pe --jobage 7 --format table
bun run src/cli.ts detail codeable-pe/analista-de-datos-power-bi-codeable-lima --format plain
bun run typecheck
bun test             # network-free fixtures
```

See `../SKILL.md` for flags and `../url-reference.md` for the API notes.
