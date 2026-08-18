// The socket layer, end to end: real HTTP upgrade, real `@clerk/backend` token
// verification, real Bun pub/sub, real turns.
//
// The reason this is an integration test and not a unit test on `broadcast.ts`
// is that the bug it exists to catch — one team reading the other's chat — is
// only visible in what arrives at a socket. A unit test on the publisher would
// pass with the leak in place.
//
// As in `server/auth.test.ts`, there is no `CLERK_SECRET_KEY` here, so we use
// `verifyToken`'s other networkless mode (`jwtKey`, a PEM public key). Same
// verification code path; only the key source differs. The keypair comes from
// the shared `testAuth()` and MUST NOT be generated here: `@clerk/backend`
// caches a local PEM under a fixed kid, so the first key installed in the
// process wins and a second one makes these tokens fail with "JWT signature is
// invalid" — which reads as a database or ordering bug. See the note in
// `server/services/testing.ts`.
//
// The server here runs on its own scratch database, pointed at by `DATABASE_PATH`
// set BEFORE `./app` is imported. That is deliberately not a mutable module slot
// (there used to be a `setRouteDb`): `bun test` runs every file in one process,
// and a shared slot lets one file re-point another file's already-listening
// server. Port 0 for the same reason — the OS picks a free one, so nothing can
// collide on a hard-coded number.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { users } from "../shared/schema";
import { freshDb, testAuth, type Harness, type TestAuth } from "./services/testing";
import { currentUnit, seedMatch, type SeededMatch } from "./services/testing";
import { applyTurn, forfeit } from "./services/matches";
import { publishRoom, startRecording, stopRecording } from "./services/broadcast";

/** Assigned by the OS in `beforeAll`; there is no fixed port to collide on. */
let port = 0;
const base = () => `http://localhost:${port}`;

let auth: TestAuth;
let h: Harness;
let seeded: SeededMatch;
let server: { stop: (force?: boolean) => void };

async function mint(subject: string): Promise<string> {
  return await auth.mint(subject);
}

/**
 * A socket plus everything it ever received. Frames are kept raw and parsed on
 * demand so an assertion can talk about "any frame mentioning message text",
 * not just the ones we thought to model.
 */
type Client = {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  raw: Array<string>;
  typesOf: (type: string) => Array<Record<string, unknown>>;
  close: () => Promise<void>;
};

async function connect(token: string, roomId: string): Promise<Client> {
  // Token in the query string: browsers cannot set headers on `new WebSocket`.
  const ws = new WebSocket(`ws://localhost:${port}/ws?roomId=${roomId}&token=${token}`);
  const raw: Array<string> = [];
  const frames: Array<Record<string, unknown>> = [];
  ws.onmessage = (e) => {
    const text = String(e.data);
    raw.push(text);
    frames.push(JSON.parse(text) as Record<string, unknown>);
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket failed to open"));
  });
  // Wait for the server's `hello`, which proves `.resolve()` populated
  // `ws.data` before `open` ran.
  await until(() => frames.length > 0);
  return {
    ws,
    raw,
    frames,
    typesOf: (type) => frames.filter((f) => f.type === type),
    close: async () => {
      ws.close();
      await Bun.sleep(30);
    },
  };
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for socket frames");
    await Bun.sleep(10);
  }
}

/**
 * Attempt an upgrade that is expected to FAIL, and report what happened.
 *
 * Resolves on whichever of `open`/`error`/`close` fires first, then waits out
 * `settle()` so a socket that opened and only later received something is still
 * caught. `raw` must stay empty: a refused upgrade must never deliver a frame,
 * least of all the authenticated `hello`.
 */
async function refuse(url: string): Promise<{ opened: boolean; raw: Array<string> }> {
  const ws = new WebSocket(url);
  const raw: Array<string> = [];
  let opened = false;
  ws.onmessage = (e) => raw.push(String(e.data));
  await new Promise<void>((resolve) => {
    ws.onopen = () => {
      opened = true;
      resolve();
    };
    ws.onerror = () => resolve();
    ws.onclose = () => resolve();
  });
  await settle();
  ws.close();
  return { opened, raw };
}

/** Let every queued publish land before asserting on what did NOT arrive. */
async function settle(): Promise<void> {
  await Bun.sleep(120);
}

/** Take one turn as whoever is on the clock, optionally with team chat. */
async function takeTurn(message?: string): Promise<"a" | "b"> {
  const unit = currentUnit(h.db, seeded.matchId);
  await applyTurn(h.db, {
    matchId: seeded.matchId,
    unitId: unit._id,
    action: { kind: "wait" },
    message,
  });
  return unit.team;
}

beforeAll(async () => {
  auth = await testAuth();

  h = freshDb();
  seeded = seedMatch(h.db);
  // A third identity that is NOT a player in the room: the spectator case.
  h.db.insert(users).values({ clerkId: "clerk_c", name: "Carol" }).run();

  // The route tree resolves its database through `getDb()`, which reads
  // `DATABASE_PATH` on first use and caches. Setting it here — before `./app` is
  // imported, and therefore before any request can arrive — is the whole
  // wiring. `h.db` is a second connection to the same file, which WAL and the
  // shared `busy_timeout` make safe.
  process.env.DATABASE_PATH = join(h.dir, "test.db");

  const { app } = await import("./app");
  const listening = app.listen(0) as unknown as {
    stop: (force?: boolean) => void;
    server: { port: number } | null;
  };
  server = listening;
  port = listening.server?.port ?? 0;
  expect(port).toBeGreaterThan(0);
  await Bun.sleep(50);
});

afterAll(() => {
  server?.stop(true);
  h.cleanup();
});

describe("upgrade and identity", () => {
  test("identity is resolved during the upgrade, so the first frame is already authenticated", async () => {
    const token = await mint("clerk_a");
    const client = await connect(token, seeded.roomId);
    const hello = client.frames[0];
    expect(hello.type).toBe("hello");
    expect(hello.userId).toBe(seeded.userA);
    expect(hello.team).toBe("a");
    expect(hello.spectator).toBe(false);
    await client.close();
  });

  test("a socket that sends a message immediately still gets an answer", async () => {
    // The spike's footgun: an async `open` means the first `message` arrives
    // before identity exists and the socket goes silent with no error.
    const token = await mint("clerk_b");
    const ws = new WebSocket(`ws://localhost:${port}/ws?roomId=${seeded.roomId}&token=${token}`);
    const got: Array<string> = [];
    ws.onmessage = (e) => got.push(String(e.data));
    ws.onopen = () => ws.send(JSON.stringify({ type: "ping" }));
    await until(() => got.some((f) => f.includes("pong")));
    expect(got.some((f) => f.includes("pong"))).toBe(true);
    ws.close();
  });

  // These two used to be plain `fetch()` calls asserting 401, and they were
  // asserting the wrong thing: Elysia's `.ws()` route only matches a genuine
  // upgrade request, so a non-upgrade GET never reaches the `.resolve()` where
  // auth lives and falls through to the 404 handler. A 404 there says nothing
  // about whether an unauthenticated *socket* can be opened, which is the thing
  // that actually matters. So both now attempt a real upgrade.
  test("no token is refused at the upgrade and no socket is ever opened", async () => {
    const attempt = await refuse(`ws://localhost:${port}/ws?roomId=${seeded.roomId}`);
    expect(attempt.opened).toBe(false);
    expect(attempt.raw).toEqual([]);
  });

  test("a garbage token is refused at the upgrade and no socket is ever opened", async () => {
    const attempt = await refuse(`ws://localhost:${port}/ws?roomId=${seeded.roomId}&token=not.a.jwt`);
    expect(attempt.opened).toBe(false);
    expect(attempt.raw).toEqual([]);
    // And specifically: never an authenticated frame.
    expect(attempt.raw.filter((f) => f.includes("hello"))).toEqual([]);
  });

  // A valid token for a user whose row does not exist is refused too: the socket
  // uses `currentUser`, not `requireUser`, so it cannot create the row.
  test("a validly-signed token for an unknown user is still refused", async () => {
    const token = await mint("clerk_nobody");
    const attempt = await refuse(`ws://localhost:${port}/ws?roomId=${seeded.roomId}&token=${token}`);
    expect(attempt.opened).toBe(false);
    expect(attempt.raw).toEqual([]);
  });

  test("/ws is a concrete route and is not swallowed by the SPA fallback", async () => {
    const res = await fetch(`${base()}/ws?roomId=${seeded.roomId}&token=not.a.jwt`);
    // The fallback would have returned index.html with a 200.
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });
});

describe("team chat never crosses teams", () => {
  test("the enemy socket receives zero message frames, and a spectator receives none at all", async () => {
    const [tokenA, tokenB, tokenC] = await Promise.all([
      mint("clerk_a"),
      mint("clerk_b"),
      mint("clerk_c"),
    ]);
    const a = await connect(tokenA, seeded.roomId);
    const b = await connect(tokenB, seeded.roomId);
    const viewer = await connect(tokenC, seeded.roomId);
    expect(viewer.frames[0].spectator).toBe(true);
    expect(viewer.frames[0].team).toBe(null);

    // A client trying to name its own team. Both the honest-looking and the
    // hostile shapes, before and during the turn.
    a.ws.send(JSON.stringify({ type: "subscribe", team: "b" }));
    a.ws.send(JSON.stringify({ team: "b" }));
    b.ws.send(JSON.stringify({ type: "subscribe", roomId: seeded.roomId, team: "a" }));
    await settle();

    const chattingTeam = await takeTurn("ENEMY PLANS: flank left on round three");
    const other = chattingTeam === "a" ? b : a;
    const own = chattingTeam === "a" ? a : b;
    await until(() => own.typesOf("message:new").length > 0);
    await settle();

    // The team that spoke hears itself.
    expect(own.typesOf("message:new").length).toBe(1);
    // The enemy hears nothing, in any frame, in any shape.
    expect(other.typesOf("message:new").length).toBe(0);
    expect(other.raw.filter((f) => f.includes("ENEMY PLANS"))).toEqual([]);
    // The spectator hears nothing either.
    expect(viewer.typesOf("message:new").length).toBe(0);
    expect(viewer.raw.filter((f) => f.includes("ENEMY PLANS"))).toEqual([]);
    // Both players and the spectator all still see the board.
    expect(a.typesOf("match:state").length).toBeGreaterThan(0);
    expect(b.typesOf("match:state").length).toBeGreaterThan(0);
    expect(viewer.typesOf("match:state").length).toBeGreaterThan(0);

    await a.close();
    await b.close();
    await viewer.close();
  });

  test("publishRoom refuses an event carrying message text", () => {
    const recorded = startRecording();
    expect(() =>
      publishRoom("room_x", {
        type: "match:state",
        roomId: "room_x",
        matchId: "m",
        // The regression: chat smuggled into the room-channel snapshot.
        messages: [],
      } as never),
    ).toThrow(/must not carry message text/);
    expect(recorded).toEqual([]);
    stopRecording();
  });

  test("publishRoom refuses to reveal chat for a match that is not finished", () => {
    startRecording();
    expect(() =>
      publishRoom("room_x", {
        type: "match:finished",
        roomId: "room_x",
        matchId: "m",
        match: { status: "running" },
        units: [],
        winnerTeam: "a",
        messages: [{ text: "secret" }],
      } as never),
    ).toThrow(/not finished/);
    stopRecording();
  });
});

describe("ordering and commit discipline", () => {
  test("a rolled-back turn publishes nothing", async () => {
    const token = await mint("clerk_a");
    const a = await connect(token, seeded.roomId);
    const before = a.frames.length;

    // Wrong unit: `applyTurnLocked` throws before any write, the transaction
    // rolls back, and the broadcast below it must never run.
    const wrong = h.db
      .select()
      .from(users)
      .where(eq(users._id, seeded.userA))
      .get();
    expect(wrong).toBeTruthy();
    await expect(
      applyTurn(h.db, {
        matchId: seeded.matchId,
        unitId: "definitely-not-a-unit",
        action: { kind: "wait" },
        message: "should never be seen",
      }),
    ).rejects.toThrow();
    await settle();
    expect(a.frames.length).toBe(before);
    expect(a.raw.filter((f) => f.includes("should never be seen"))).toEqual([]);
    await a.close();
  });

  test("a committed turn publishes the turn row, then the full snapshot", async () => {
    const token = await mint("clerk_b");
    const b = await connect(token, seeded.roomId);
    const before = b.frames.length;
    await takeTurn();
    await until(() => b.frames.length > before + 1);
    const emitted = b.frames.slice(before).map((f) => f.type);
    expect(emitted.indexOf("match:turn")).toBeLessThan(emitted.indexOf("match:state"));

    // The snapshot must be WHOLE. `MatchView` diffs consecutive `units` arrays
    // to draw damage numbers; a granular patch renders a correct board with no
    // damage popups on it, which nobody files a bug about.
    const state = b.typesOf("match:state").at(-1)!;
    expect(state.match).toBeTruthy();
    expect(Array.isArray(state.units)).toBe(true);
    expect((state.units as Array<unknown>).length).toBe(6);
    await b.close();
  });
});

describe("reconnect re-seeds", () => {
  test("state missed while disconnected is whole again after an HTTP re-fetch", async () => {
    const token = await mint("clerk_a");
    const a = await connect(token, seeded.roomId);
    await takeTurn();
    await until(() => a.typesOf("match:state").length > 0);
    await a.close();

    // Turns taken while the socket is down. Nothing replays these; the client's
    // only recovery is to re-fetch, which is exactly what `useRoomSocket` does.
    await takeTurn("chatter while offline");
    await takeTurn();
    const missed = await fetch(`${base()}/api/matches/by-room/${seeded.roomId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const snapshot = (await missed.json()) as { match: { turnNumber: number }; units: Array<unknown> };

    const again = await connect(token, seeded.roomId);
    expect(again.frames[0].type).toBe("hello");
    // The reconnected socket learned nothing about the missed turns by itself…
    expect(again.typesOf("match:state").length).toBe(0);
    // …but the re-fetch has the whole board, at the current turn.
    expect(snapshot.units.length).toBe(6);
    expect(snapshot.match.turnNumber).toBe(currentTurnNumber());

    // And it is live again from here.
    await takeTurn();
    await until(() => again.typesOf("match:state").length > 0);
    await again.close();
  });
});

function currentTurnNumber(): number {
  const unit = currentUnit(h.db, seeded.matchId);
  expect(unit).toBeTruthy();
  const state = h.db;
  void state;
  const { getMatch } = require("./services/testing") as typeof import("./services/testing");
  return getMatch(h.db, seeded.matchId).turnNumber;
}

describe("forfeit", () => {
  test("conceding publishes the finished match and reveals both teams' chat", async () => {
    const token = await mint("clerk_a");
    const a = await connect(token, seeded.roomId);
    const me = h.db.select().from(users).where(eq(users._id, seeded.userA)).get()!;
    await forfeit(h.db, me, seeded.matchId);
    await until(() => a.typesOf("match:finished").length > 0);
    const finished = a.typesOf("match:finished")[0];
    expect(finished.winnerTeam).toBe("b");
    // Legal here and ONLY here: the reveal mirrors `matches.replay`'s
    // `status === "finished"` gate.
    expect(Array.isArray(finished.messages)).toBe(true);
    await a.close();
  });
});
