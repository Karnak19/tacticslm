// Test fixtures for the service layer. Not imported by anything that ships.
//
// Every test gets its own file-backed database (not `:memory:`) because
// `PRAGMA journal_mode = WAL` and the busy timeout only mean anything on a real
// file, and those are exactly the settings the concurrency behaviour depends on.

import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STARTER_UNITS } from "../../shared/starters";
import { matches, players, rooms, units, users } from "../../shared/schema";
import type { Match, Unit } from "../../shared/types";
import { createDb, type Db } from "../db/client";
import { startMatch } from "./rooms";

export type Harness = {
  db: Db;
  dir: string;
  cleanup: () => void;
};

export function freshDb(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "tacticslm-test-"));
  const db = createDb(join(dir, "test.db"));
  migrate(db, { migrationsFolder: "server/db/migrations" });
  return { db, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export type SeededMatch = {
  matchId: string;
  roomId: string;
  userA: string;
  userB: string;
  playerA: string;
  playerB: string;
};

/**
 * A running 3v3 match with two distinct commanders. `seed` and `gridSize` are
 * pinned so wall layout and initiative are identical run to run.
 */
export function seedMatch(db: Db, opts?: { gridSize?: number; seed?: number }): SeededMatch {
  const [userA] = db.insert(users).values({ clerkId: "clerk_a", name: "Alice" }).returning().all();
  const [userB] = db.insert(users).values({ clerkId: "clerk_b", name: "Bob" }).returning().all();
  const [room] = db.insert(rooms).values({ code: "TESTAA", status: "lobby" }).returning().all();

  const playerIds: Record<"a" | "b", string> = { a: "", b: "" };
  for (const [team, user] of [
    ["a", userA],
    ["b", userB],
  ] as const) {
    const [player] = db
      .insert(players)
      .values({ roomId: room._id, userId: user._id, name: user.name, team, ready: true })
      .returning()
      .all();
    playerIds[team] = player._id;
    db.insert(units)
      .values(
        STARTER_UNITS.map((unit) => ({
          roomId: room._id,
          playerId: player._id,
          team,
          ...unit,
          // Team B gets suffixed names: the brain resolves targets by name.
          name: team === "a" ? unit.name : `${unit.name} II`,
        })),
      )
      .run();
  }

  const matchId = startMatch(db, room._id, {
    gridSize: opts?.gridSize ?? 12,
    seed: opts?.seed ?? 7,
  });
  return {
    matchId,
    roomId: room._id,
    userA: userA._id,
    userB: userB._id,
    playerA: playerIds.a,
    playerB: playerIds.b,
  };
}

export function getMatch(db: Db, matchId: string): Match {
  const match = db.select().from(matches).where(eq(matches._id, matchId)).get();
  if (!match) throw new Error("no match");
  return match;
}

export function getUnit(db: Db, unitId: string): Unit {
  const unit = db.select().from(units).where(eq(units._id, unitId)).get();
  if (!unit) throw new Error("no unit");
  return unit;
}

export function currentUnit(db: Db, matchId: string): Unit {
  const match = getMatch(db, matchId);
  if (!match.currentUnitId) throw new Error("match has no current unit");
  return getUnit(db, match.currentUnitId);
}

export function getUser(db: Db, userId: string) {
  const user = db.select().from(users).where(eq(users._id, userId)).get();
  if (!user) throw new Error("no user");
  return user;
}

// ── SHARED TEST AUTH ────────────────────────────────────────────────────────
// One RSA keypair for the WHOLE test process, and it has to be that way.
//
// VERIFIED, and it cost most of a debugging session: `@clerk/backend` caches a
// locally-supplied PEM (`jwtKey` mode) in a module-level map under a FIXED kid
// ("local"). The first PEM any code hands `verifyToken` is therefore pinned for
// the lifetime of the process, and every later PEM is silently ignored — tokens
// signed with the newer key fail as "JWT signature is invalid".
//
// So two test files that each generate their own keypair pass in isolation and
// break each other in one `bun test` run: whichever file's `beforeAll` runs
// first wins the cache, and the other file's sockets and requests all 401. The
// failure looks exactly like a database or ordering problem, which is why it ate
// a session. `testAuth()` removes the possibility by minting the process's one
// keypair lazily and handing every caller the same signer.
//
// Corollary: nothing may restore `CLERK_JWT_KEY` to its previous value in an
// `afterAll`. A file that clears it breaks every file that runs after it, and
// re-setting a *different* key would not help anyway (see the cache above).

export type TestAuth = {
  /** The public key, PEM/SPKI. Already installed as `CLERK_JWT_KEY`. */
  publicKeyPem: string;
  /** The matching private key, for tokens `mint` cannot express (absolute `exp`). */
  signer: CryptoKey;
  /** A Clerk-shaped session JWT for `subject`, signed with the process key. */
  mint: (subject: string, claims?: Record<string, unknown>, expires?: string) => Promise<string>;
  /** Sign a token with a *foreign* key, for the "impostor is rejected" case. */
  mintForeign: (subject: string) => Promise<string>;
};

let sharedAuth: Promise<TestAuth> | null = null;

async function buildTestAuth(): Promise<TestAuth> {
  const { generateKeyPairSync } = await import("node:crypto");
  const { importPKCS8, SignJWT } = await import("jose");

  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signer = await importPKCS8(
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    "RS256",
  );
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  // `jwtKey` is `verifyToken`'s fully networkless mode — same verification code
  // path as production, only the key source differs. There must be no
  // `CLERK_SECRET_KEY`, or `authConfig()` would prefer it and try the network.
  process.env.CLERK_JWT_KEY = publicKeyPem;
  delete process.env.CLERK_SECRET_KEY;

  const sign = async (key: CryptoKey, subject: string, claims: Record<string, unknown>, expires: string) =>
    await new SignJWT({ sid: "sess_1", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://example.clerk.accounts.dev")
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(expires)
      .sign(key);

  return {
    publicKeyPem,
    signer,
    mint: async (subject, claims = {}, expires = "1h") => await sign(signer, subject, claims, expires),
    mintForeign: async (subject) => {
      const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const impostor = await importPKCS8(
        foreign.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        "RS256",
      );
      return await sign(impostor, subject, {}, "1h");
    },
  };
}

/** The process's one and only test keypair. Idempotent; safe from any `beforeAll`. */
export function testAuth(): Promise<TestAuth> {
  sharedAuth ??= buildTestAuth();
  return sharedAuth;
}
