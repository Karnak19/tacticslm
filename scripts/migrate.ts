// `bun run db:migrate` — apply pending migrations and exit.
//
// The server also migrates at boot, so this is for setting up a fresh checkout
// or a deploy step where you want the schema in place before anything serves.
import { runMigrations } from "../server/db/migrate";
import { dbPath } from "../server/db/client";

runMigrations();
console.log(`migrations applied to ${dbPath()}`);
