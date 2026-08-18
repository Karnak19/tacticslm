// Authentication. Replaces `convex/lib/auth.ts`.
//
// Convex handed us a verified identity via `ctx.auth.getUserIdentity()`. Here we
// verify the Clerk session JWT ourselves with `@clerk/backend`'s `verifyToken`,
// which is networkless after one JWKS fetch (and fully networkless in `jwtKey`
// mode). `identity.subject` is the Clerk user id and maps to `users.clerkId`.
//
// The one behavioural change from Convex: `ensureUser` moved server-side.
// `src/App.tsx` used to fire `users.ensure` from the client on mount, which
// raced every other first request — a fresh commander could hit `rooms.create`
// before their row existed. Now `requireUser` creates the row and seeds
// `STARTER_UNITS` lazily on the first authenticated request, so the race has
// nowhere to happen.

import { verifyToken } from "@clerk/backend";
import { eq } from "drizzle-orm";
import { rosterUnits, users } from "../shared/schema";
import { STARTER_UNITS } from "../shared/starters";
import type { User } from "../shared/types";
import type { Db } from "./db/client";

/** The verified caller. Only the fields we actually consume. */
export type Identity = { subject: string; name: string };

const DEFAULT_NAME = "Commander";

/**
 * `CLERK_JWT_KEY` (a PEM public key) is the fully networkless mode and is what
 * the tests use; `CLERK_SECRET_KEY` is the production mode. Exactly one is
 * required.
 */
function authConfig(): { jwtKey: string } | { secretKey: string } {
  const jwtKey = process.env.CLERK_JWT_KEY;
  if (jwtKey) return { jwtKey };
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (secretKey) return { secretKey };
  throw new Error(
    "CLERK_SECRET_KEY is not set (or CLERK_JWT_KEY for networkless verification). " +
      "Token verification cannot work without it.",
  );
}

/**
 * Call this once at startup. Without it, a missing `CLERK_SECRET_KEY` surfaces
 * as every request returning 401, which looks like "my login is broken" rather
 * than "the server is misconfigured".
 */
export function assertAuthConfigured(): void {
  authConfig();
}

/**
 * Verify a bearer token. Returns null for a missing, malformed, expired or
 * otherwise invalid token — the caller turns that into a 401. A *configuration*
 * problem throws instead, so it cannot be mistaken for a bad credential.
 */
export async function verifyIdentity(token: string | null | undefined): Promise<Identity | null> {
  const config = authConfig(); // throws on misconfiguration, before we look at the token
  if (!token) return null;
  try {
    const claims = await verifyToken(token, config);
    if (!claims.sub) return null;
    // Clerk puts the display name in custom claims; shapes vary by JWT template,
    // so read defensively rather than trusting one field to exist.
    const custom = claims as unknown as { nickname?: unknown; name?: unknown };
    const nickname = typeof custom.nickname === "string" ? custom.nickname : undefined;
    const name = typeof custom.name === "string" ? custom.name : undefined;
    return { subject: claims.sub, name: nickname ?? name ?? DEFAULT_NAME };
  } catch {
    return null;
  }
}

/** Bearer token out of an `Authorization` header, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return (
    message.includes("UNIQUE constraint failed") ||
    (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT"))
  );
}

function findByClerkId(db: Db, clerkId: string): User | undefined {
  return db.select().from(users).where(eq(users.clerkId, clerkId)).get();
}

/** Look up the caller without creating anything. Read paths use this. */
export async function currentUser(db: Db, token: string | null | undefined): Promise<User | null> {
  const identity = await verifyIdentity(token);
  if (!identity) return null;
  return findByClerkId(db, identity.subject) ?? null;
}

/**
 * The caller, created (with starter roster) if this is their first authenticated
 * request. Throws "Not authenticated" for an invalid token, matching Convex's
 * message so error handling upstream is unchanged.
 */
export async function requireUser(db: Db, token: string | null | undefined): Promise<User> {
  const identity = await verifyIdentity(token);
  if (!identity) throw new Error("Not authenticated");
  return ensureUser(db, identity);
}

/**
 * The user row for a verified identity, created on first sight along with the
 * starter roster. `requireUser` without the token step.
 *
 * THE RACE. Two parallel first requests from the same brand-new commander both
 * run the SELECT, both miss, and both INSERT. Convex's serializable mutations
 * made that impossible; here the `users_by_clerk` UNIQUE index is the only thing
 * standing in the way, so we lean on it deliberately: insert optimistically, and
 * treat a constraint violation as "the other request won, re-read". A naive
 * check-then-insert would hand one of the two callers a 500 — and worse, a
 * second roster seed would double every new player's units.
 *
 * The user insert and the roster seed share one transaction so no request can
 * ever observe a user with a half-built roster. The transaction body is
 * deliberately synchronous: `bun:sqlite` transactions are, and an `await` inside
 * one would let unrelated work interleave into the open transaction.
 */
export function ensureUser(db: Db, identity: Identity): User {
  const existing = findByClerkId(db, identity.subject);
  if (existing) {
    // Keep the display name fresh, as `convex/lib/auth.ts` did.
    if (identity.name !== existing.name && identity.name !== DEFAULT_NAME) {
      const updated = db
        .update(users)
        .set({ name: identity.name })
        .where(eq(users._id, existing._id))
        .returning()
        .get();
      if (updated) return updated;
    }
    return existing;
  }

  try {
    return db.transaction((tx) => {
      const created = tx
        .insert(users)
        .values({ clerkId: identity.subject, name: identity.name })
        .returning()
        .get();
      if (!created) throw new Error("Failed to create user");
      // Every new commander starts with a ready-to-fight squad.
      tx.insert(rosterUnits)
        .values(STARTER_UNITS.map((unit) => ({ userId: created._id, ...unit })))
        .run();
      return created;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Someone else inserted between our SELECT and our INSERT. Their transaction
    // committed (that is why ours conflicted), roster included.
    const raced = findByClerkId(db, identity.subject);
    if (!raced) throw error;
    return raced;
  }
}
