// Shared plumbing for every route module.
//
// Convex gave each function a `ctx` with the database and the caller already on
// it. Here that is a small Elysia plugin: it derives the bearer token from the
// request and exposes `user()` / `maybeUser()` so a handler's first line reads
// like the Convex original.
//
// `.as("scoped")` is what makes the derive visible to the parent instance that
// `.use()`s this plugin. Without it the derived properties stay local and every
// handler sees `undefined`.

// ── WHY THERE IS NO `setRouteDb` ANY MORE ──────────────────────────────────
// Stage 4 had a module-level `dbOverride` plus a `setRouteDb()` so a test could
// point the whole route tree at a scratch database. That is one mutable slot
// shared by every consumer in the process, and `bun test` runs every file in ONE
// process: two files that both set it silently hand the second file's database to
// the first file's already-running server, and the resulting 401s look like an
// auth bug.
//
// The override is not needed at all. `getDb()` resolves `DATABASE_PATH` on first
// use and caches, so a test that wants the server on a scratch database sets
// `DATABASE_PATH` *before* importing `server/app.ts` and gets there with no
// mutable state and nothing to restore. `server/ws.test.ts` does exactly that.
// A second connection to the same file is fine — WAL is on and every connection
// sets `busy_timeout` (see `server/db/client.ts`).

import { Elysia } from "elysia";
import { bearerToken, currentUser, requireUser } from "../auth";
import { getDb } from "../db/client";
import type { User } from "../../shared/types";

/** The request's database. One line so route modules read like the Convex `ctx`. */
export function db() {
  return getDb();
}

export const context = new Elysia({ name: "tacticslm/context" })
  .derive(({ headers }) => {
    const token = bearerToken(headers.authorization);
    return {
      db: db(),
      token,
      /** The caller, created on first sight. Throws "Not authenticated" -> 401. */
      user: (): Promise<User> => requireUser(db(), token),
      /** The caller, or null. For read paths that degrade to an empty result. */
      maybeUser: (): Promise<User | null> => currentUser(db(), token),
    };
  })
  .as("scoped");
