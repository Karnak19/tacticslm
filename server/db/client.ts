// The Drizzle instance. `bun:sqlite` is safe here because the whole server runs
// under Bun — there is no Node process anywhere in the target stack.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../shared/schema";

export const DEFAULT_DB_PATH = "data/tacticslm.db";

/**
 * Resolved on every call, not once at import.
 *
 * A module-level `const DB_PATH = process.env.DATABASE_PATH ?? …` looks
 * identical and is subtly wrong: importing anything that pulls in this module —
 * a schema type, a test fixture — freezes the path before a test has had a
 * chance to set `DATABASE_PATH`, so the override silently does nothing.
 */
export function dbPath(): string {
  return process.env.DATABASE_PATH ?? DEFAULT_DB_PATH;
}

export function createSqlite(path: string = dbPath()): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true });
  // WAL: readers never block the writer, which matters because a match tick
  // writes while every spectator is reading.
  sqlite.exec("PRAGMA journal_mode = WAL;");
  // Wait out a concurrent writer instead of throwing SQLITE_BUSY immediately.
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  // SQLite defaults foreign keys OFF, and does so per connection. Our cascades
  // need them on, so every connection sets it.
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA synchronous = NORMAL;");
  return sqlite;
}

export function createDb(path: string = dbPath()) {
  return drizzle({ client: createSqlite(path), schema });
}

export type Db = ReturnType<typeof createDb>;

/**
 * The transaction handle `db.transaction` hands its callback.
 *
 * Worth stating plainly, because it shapes every service in `server/services/`:
 * `bun:sqlite` transactions are SYNCHRONOUS. The callback returns `T`, not
 * `Promise<T>`, so inside a transaction you must use Drizzle's sync terminators
 * (`.get()`, `.all()`, `.run()`) and never `await`. That is a feature here — it
 * makes the whole body one uninterruptible critical section on the single
 * connection — but it means the relational query API (`db.query.*`, promise-only)
 * is off limits inside transactions.
 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Anything you can read through: the database, or an open transaction. */
export type DbLike = Db | Tx;

let cached: Db | undefined;

/**
 * The process-wide database. Lazy on purpose: importing this module must not
 * touch the filesystem, so tooling and tests can import the schema freely.
 */
export function getDb(): Db {
  cached ??= createDb();
  return cached;
}

export { schema };
