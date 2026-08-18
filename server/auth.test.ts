// Auth tests. There is NO `CLERK_SECRET_KEY` in this environment, so these
// exercise `verifyToken`'s other networkless mode — `jwtKey`, a PEM public key —
// exactly as the spike did (`spike/clerk-check.ts`). Same verification code path
// inside @clerk/backend; only the key source differs.
//
// The keypair comes from `testAuth()` and NOT from a local `generateKeyPairSync`.
// `@clerk/backend` caches a locally-supplied PEM under a fixed kid, so the first
// key any file installs is pinned for the whole process; a second keypair here
// would make every OTHER test file's tokens fail. See the long note in
// `server/services/testing.ts`. For the same reason nothing below restores
// `CLERK_JWT_KEY`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { rosterUnits, users } from "../shared/schema";
import { STARTER_UNITS } from "../shared/starters";
import { freshDb, testAuth, type Harness, type TestAuth } from "./services/testing";
import {
  assertAuthConfigured,
  bearerToken,
  currentUser,
  ensureUser,
  requireUser,
  verifyIdentity,
} from "./auth";

let auth: TestAuth;
let h: Harness;

beforeAll(async () => {
  auth = await testAuth();
  h = freshDb();
});

afterAll(() => {
  h.cleanup();
});

async function mint(
  subject: string,
  claims: Record<string, unknown> = {},
  expires = "1h",
): Promise<string> {
  return await auth.mint(subject, claims, expires);
}

describe("token verification", () => {
  test("a valid token yields the subject and display name", async () => {
    const identity = await verifyIdentity(await mint("user_1", { nickname: "Ada" }));
    expect(identity).toEqual({ subject: "user_1", name: "Ada" });
  });

  test("nickname wins over name, and both falling back to Commander", async () => {
    expect(
      await verifyIdentity(await mint("user_2", { nickname: "Nick", name: "Full Name" })),
    ).toEqual({ subject: "user_2", name: "Nick" });
    expect(await verifyIdentity(await mint("user_3", { name: "Full Name" }))).toEqual({
      subject: "user_3",
      name: "Full Name",
    });
    expect(await verifyIdentity(await mint("user_4"))).toEqual({
      subject: "user_4",
      name: "Commander",
    });
  });

  test("missing, malformed and expired tokens are all just null", async () => {
    expect(await verifyIdentity(null)).toBeNull();
    expect(await verifyIdentity("")).toBeNull();
    expect(await verifyIdentity("garbage.tok.en")).toBeNull();
    const stale = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://example.clerk.accounts.dev")
      .setSubject("user_x")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(auth.signer);
    expect(await verifyIdentity(stale)).toBeNull();
  });

  test("a token signed by someone else is rejected", async () => {
    expect(await verifyIdentity(await auth.mintForeign("user_admin"))).toBeNull();
  });

  // A missing key is a SERVER fault, and must not look like a bad credential:
  // returning null here would render as "your login expired" on every request.
  test("a missing key throws instead of 401-ing", async () => {
    const key = process.env.CLERK_JWT_KEY;
    delete process.env.CLERK_JWT_KEY;
    try {
      expect(() => assertAuthConfigured()).toThrow(/CLERK_SECRET_KEY is not set/);
      await expect(verifyIdentity(await mint("user_1"))).rejects.toThrow(/CLERK_SECRET_KEY/);
    } finally {
      process.env.CLERK_JWT_KEY = key;
    }
  });

  test("bearerToken pulls the token out of the header", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe("lazy user creation", () => {
  test("the first authenticated request creates the user and the starter roster", async () => {
    const token = await mint("clerk_new", { nickname: "Newbie" });
    expect(await currentUser(h.db, token)).toBeNull(); // reads never create

    const user = await requireUser(h.db, token);
    expect(user.clerkId).toBe("clerk_new");
    expect(user.name).toBe("Newbie");

    const roster = h.db.select().from(rosterUnits).where(eq(rosterUnits.userId, user._id)).all();
    expect(roster).toHaveLength(STARTER_UNITS.length);
    expect(roster.map((r) => r.name).sort()).toEqual(STARTER_UNITS.map((s) => s.name).sort());
    // The loadout survived the JSON column round-trip.
    expect(roster[0].loadout.consumables).toHaveLength(2);
  });

  test("a second request reuses the row and does not re-seed the roster", async () => {
    const token = await mint("clerk_repeat", { nickname: "Repeat" });
    const first = await requireUser(h.db, token);
    const second = await requireUser(h.db, token);
    expect(second._id).toBe(first._id);
    expect(
      h.db.select().from(rosterUnits).where(eq(rosterUnits.userId, first._id)).all(),
    ).toHaveLength(STARTER_UNITS.length);
  });

  test("an invalid token is rejected before anything is created", async () => {
    const before = h.db.select().from(users).all().length;
    await expect(requireUser(h.db, "garbage.tok.en")).rejects.toThrow("Not authenticated");
    expect(h.db.select().from(users).all()).toHaveLength(before);
  });

  test("the display name is refreshed when it changes", async () => {
    const user = await requireUser(h.db, await mint("clerk_rename", { nickname: "Before" }));
    const renamed = await requireUser(h.db, await mint("clerk_rename", { nickname: "After" }));
    expect(renamed._id).toBe(user._id);
    expect(renamed.name).toBe("After");
  });

  // ── The race ─────────────────────────────────────────────────────────────
  // Convex's mutations were serializable, so "SELECT, miss, INSERT" was safe.
  // Here two parallel first requests can both miss. The two tests below pin down
  // both halves of the guard: the UNIQUE index really does reject the second
  // insert, and `ensureUser` treats that rejection as "re-read", not as a 500.
  test("parallel first requests produce exactly one user and one roster", async () => {
    const token = await mint("clerk_race", { nickname: "Racer" });
    const results = await Promise.all([
      requireUser(h.db, token),
      requireUser(h.db, token),
      requireUser(h.db, token),
      requireUser(h.db, token),
    ]);
    const ids = new Set(results.map((u) => u._id));
    expect(ids.size).toBe(1);
    expect(h.db.select().from(users).where(eq(users.clerkId, "clerk_race")).all()).toHaveLength(1);
    expect(
      h.db.select().from(rosterUnits).where(eq(rosterUnits.userId, results[0]._id)).all(),
    ).toHaveLength(STARTER_UNITS.length);
  });

  test("the UNIQUE index rejects a duplicate, and ensureUser recovers by re-reading", () => {
    const identity = { subject: "clerk_unique", name: "Solo" };
    const first = ensureUser(h.db, identity);

    // This is precisely what the losing request's INSERT does.
    expect(() =>
      h.db.insert(users).values({ clerkId: "clerk_unique", name: "Duplicate" }).run(),
    ).toThrow(/UNIQUE constraint failed/);

    // And this is what it does next: re-read and carry on with the winner's row.
    const recovered = ensureUser(h.db, identity);
    expect(recovered._id).toBe(first._id);
    expect(h.db.select().from(users).where(eq(users.clerkId, "clerk_unique")).all()).toHaveLength(
      1,
    );
  });
});
