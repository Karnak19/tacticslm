# TacticsLM

Bun + Elysia server (`server/`), React SPA (`src/`), isomorphic engine and schema
(`shared/`). State lives in SQLite through Drizzle; live updates go out over a
WebSocket. There is no Convex any more — anything in a comment saying "port of
`convex/…`" is a note about where the code came from.

## Commands

- `bun run dev` — Vite on :5173 plus the Elysia API on :4321
- `bun run db:migrate` — apply Drizzle migrations (boot does it too)
- `bun run play` — the match harness (`--watch` / `--seed` / `--room`); needs
  `ADMIN_TOKEN` set to the same value the server runs with
- `bun run devtools` — browse recorded LLM calls
- `bunx tsc -b`, `bunx oxlint .`, `bun test`, `bun run build`

## Invariants worth knowing before editing

- `applyTurn` is reachable only from `server/services/brain.ts`. No route may
  touch it — `server/services/applyTurn-boundary.test.ts` enforces it.
- Team is always read from the server-resolved `players` row, never taken from
  the client.
- `server/routes/dev.ts` is a deliberate auth bypass: it is mounted only when
  `NODE_ENV !== "production"` and every request needs the `ADMIN_TOKEN` bearer.
- The LLM settings in `server/services/brain.ts` were expensive to find. Read the
  comments before changing them.
