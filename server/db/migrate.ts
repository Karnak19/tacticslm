import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb } from "./client";

/**
 * Bring the schema up to date.
 *
 * Lives with the db layer rather than in `server/app.ts` so that migrating does
 * not require constructing the HTTP app: `scripts/migrate.ts` imports this and
 * nothing else. Both the boot path and the CLI call this one function, so the
 * two cannot drift.
 *
 * Idempotent — Drizzle records applied files in `__drizzle_migrations`, so a
 * second run is a no-op. Running it at boot is what makes a fresh checkout work:
 * without it the first connection creates an empty `data/tacticslm.db` and every
 * query fails on a missing table.
 *
 * This is Drizzle's documented "generate + programmatic" workflow, not a
 * workaround: `migrate()` is a first-class option and the one they recommend for
 * monolithic apps. The split is that `drizzle-kit generate` writes the SQL (a
 * pure schema diff, no database driver involved) while `drizzle-kit migrate`
 * cannot apply it here — drizzle-kit has no `bun:sqlite` driver and asks for
 * better-sqlite3 or @libsql/client, and adding a second SQLite driver just to
 * satisfy a CLI is not worth it.
 *
 * So: `bunx drizzle-kit generate` after a schema change, `bun run db:migrate` (or
 * a server boot) to apply.
 */
export function runMigrations(): void {
  migrate(getDb(), { migrationsFolder: `${import.meta.dir}/migrations` });
}
