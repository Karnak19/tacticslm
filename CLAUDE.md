## Drizzle in this project

The installed `drizzle` and `drizzle-migrations` skills are generic. Three of their
recommendations do not apply here, and following them wastes time:

- **`drizzle-kit migrate` and `drizzle-kit push` do not work.** drizzle-kit has no
  `bun:sqlite` driver and will demand `better-sqlite3` or `@libsql/client`. Do not
  install a second SQLite driver to satisfy it. `drizzle-kit generate` DOES work —
  it is a pure schema diff and needs no driver.
- **Migrations are applied programmatically.** `runMigrations()` in
  `server/db/migrate.ts`, called by `bun run db:migrate` and again at server boot.
  This is Drizzle's own documented generate-then-programmatic workflow, not a
  workaround.
- **The package manager is bun**, not npm or pnpm.

So the loop after a schema change is: edit `shared/schema.ts` →
`bunx drizzle-kit generate` → `bun run db:migrate`.

Schema lives in `shared/schema.ts` rather than under `server/` because table
definitions are isomorphic and `.oxlintrc.json` forbids `shared/` from importing
`server/`. Only the `bun:sqlite` connection is server-only. Two columns are
deliberately named `_id` and `_creationTime`: they are threaded through ~1200 lines
of view code from the Convex era, and keeping the names is what let that layer
survive the migration untouched.

## Board art

The Phaser board (`src/game/BoardScene.ts`) renders CraftPix spritesheets from
`public/sprites/craftpix/`. That art is licensed for use but not redistribution,
so it is gitignored: run `bash scripts/setup-assets.sh` once per clone, or the
board comes up empty. The Kenney tiles in `public/sprites/` are CC0, committed,
and still used by the DOM views.
