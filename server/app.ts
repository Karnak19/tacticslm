// The server. One file for dev and prod — the only difference is who serves the
// HTML: in dev Vite does it and proxies `/api` here; in prod this process serves
// the built bundle from `dist/`.
//
// HANDLER ORDER IS LORE. It was established by `spike/server.ts` and every line
// of it was paid for:
//
//   1. concrete /api/* routes
//   2. .all("/api/*")          — JSON 404 for unknown non-GET /api verbs
//   3. .ws("/ws")               — concrete, so no wildcard can swallow the
//      upgrade.
//   4. staticPlugin on /assets — NEVER on prefix "/"; at "/" it installs a
//      wildcard that shadows everything registered after it and 404s every
//      deep link.
//   5. GET /*                  — static-file-or-index.html, registered LAST,
//      and policing its own /api exclusions because a bare "/*" outranks
//      "/api/*" no matter what order they were registered in.

import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { assertAuthConfigured } from "./auth";
import { getDb } from "./db/client";
import { context } from "./routes/context";
import { roomRoutes } from "./routes/rooms";
import { matchRoutes } from "./routes/matches";
import { rosterRoutes } from "./routes/roster";
import { coachRoutes } from "./routes/coach";
import { brainRoutes } from "./routes/brain";
import { wsRoutes } from "./routes/ws";

const PORT = Number(process.env.PORT ?? 4321);
const DIST = process.env.DIST ?? "dist";

/**
 * Map thrown service errors onto 4xx with the message intact.
 *
 * Convex mutations threw `Error("Room is full")` and the client rendered the
 * message verbatim; the lobby UX is built out of those strings. Without this,
 * every one of them becomes an opaque 500 and the lobby goes silent about why
 * anything failed. Only messages we authored are forwarded — an unrecognised
 * error is still a 500 with a generic body, so an internal failure cannot leak
 * a stack trace or a SQL fragment to the client.
 */
const AUTH_MESSAGES = new Set(["Not authenticated"]);

function classify(message: string): 400 | 401 | 403 | 404 {
  if (AUTH_MESSAGES.has(message)) return 401;
  if (message === "Not your unit" || message.startsWith("Not a player")) return 403;
  if (message.endsWith("not found") || message.endsWith("not found.")) return 404;
  return 400;
}

/**
 * The one human sentence out of an Elysia validation failure.
 *
 * `error.message` is a JSON document containing the whole failing schema — a few
 * kilobytes of TypeBox for a missing field. `summary` inside it is the sentence
 * a person can act on ("Expected array length to be greater or equal to 3").
 */
function validationSummary(error: unknown): string {
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return "Invalid request";
  try {
    const parsed: unknown = JSON.parse(message);
    const summary = (parsed as { summary?: unknown }).summary;
    return typeof summary === "string" ? summary : "Invalid request";
  } catch {
    return message;
  }
}

/** Service errors are hand-written prose; anything else is a bug, not a message. */
function isServiceError(error: unknown): error is Error {
  return error instanceof Error && error.constructor === Error && error.message.length > 0;
}

export const app = new Elysia()
  .onError(({ code, error, status, path }) => {
    if (code === "VALIDATION") {
      // Elysia's own schema failure. `error.message` is a multi-kilobyte JSON
      // dump of the whole schema; `summary` is the one human sentence in it, and
      // it is what the client actually shows.
      return status(400, { error: validationSummary(error) });
    }
    if (code === "NOT_FOUND") return status(404, { error: "not_found", path });
    if (isServiceError(error)) {
      const code4xx = classify(error.message);
      return status(code4xx, { error: error.message });
    }
    console.error("unhandled:", error);
    return status(500, { error: "Internal error" });
  })
  .use(context)
  // ---- 1. /api ---------------------------------------------------------
  .group("/api", (api) =>
    api
      .get("/health", () => ({ ok: true as const }))
      // The caller's own row. Creates it (with the starter roster) on first sight.
      .get("/me", async ({ user }) => {
        const me = await user();
        return { _id: me._id, name: me.name, clerkId: me.clerkId };
      })
      .use(roomRoutes)
      .use(matchRoutes)
      .use(rosterRoutes)
      .use(coachRoutes)
      .use(brainRoutes)
      // ---- 2. JSON 404 for unknown /api paths ------------------------
      // Catches unknown non-GET /api verbs. Unknown GET /api/* falls through
      // to the final handler instead, because a bare "/*" outranks "/api/*";
      // that handler returns the same JSON shape.
      .all("/*", ({ status, path }) => status(404, { error: "not_found", path })),
  )
  // ---- 3. WebSocket, a CONCRETE route --------------------------------
  // Registered before the static plugin and before the SPA fallback, so
  // nothing wildcard can swallow the upgrade. The fallback below also excludes
  // `/ws` by hand, because a bare `"/*"` outranks anything more specific.
  .use(wsRoutes)
  // ---- 4. hashed Vite bundle, on a SUB-prefix --------------------------
  .use(
    await staticPlugin({
      assets: `${DIST}/assets`,
      prefix: "/assets",
      alwaysStatic: false,
      maxAge: 31536000,
    }),
  )
  // ---- 5. static-or-SPA fallback, registered LAST ----------------------
  .get("/*", async ({ path, status, set }) => {
    if (path === "/ws" || path === "/api" || path.startsWith("/api/")) {
      return status(404, { error: "not_found", path });
    }
    // Path-traversal guard: resolve and require it to stay under dist/.
    const root = resolve(process.cwd(), DIST);
    const resolved = resolve(root, `.${decodeURIComponent(path)}`);
    if (resolved.startsWith(`${root}/`)) {
      const file = Bun.file(resolved);
      if (await file.exists()) return file;
    }
    set.headers["cache-control"] = "no-cache";
    return Bun.file(`${root}/index.html`);
  });

export type App = typeof app;

/**
 * Bring the schema up to date. Runs at boot, and also standalone via
 * `bun run db:migrate` (which uses drizzle-kit against the same folder).
 *
 * Idempotent: Drizzle records applied files in `__drizzle_migrations`, so a
 * second run is a no-op. Doing it at boot is what makes a fresh checkout work —
 * without it `data/tacticslm.db` is created empty by the first connection and
 * every query fails on a missing table.
 */
export function runMigrations(): void {
  migrate(getDb(), { migrationsFolder: `${import.meta.dir}/db/migrations` });
}

if (import.meta.main) {
  // Fail loudly at boot. A missing key otherwise shows up as every request
  // returning 401, which reads as "my login broke" instead of "misconfigured".
  assertAuthConfigured();
  runMigrations();
  app.listen(PORT);
  console.log(`tacticslm on http://localhost:${PORT} (serving ${DIST})`);
}
