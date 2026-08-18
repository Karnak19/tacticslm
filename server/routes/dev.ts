// The dev harness. Port of `convex/dev.ts`, which was the thing that made the
// fighting system testable: seed a running match, drive it from the CLI, read a
// full both-teams trace, wipe the game data.
//
// ── WHY THIS FILE IS GATED TWICE ───────────────────────────────────────────
// On Convex every function here was an `internalMutation` / `internalAction`:
// unreachable from any client, callable only through the CLI's admin key. Plain
// HTTP has no such thing, and `seedMatch` is a *deliberate auth bypass* — it
// fabricates a match with no session and no ready handshake, and `act` plays a
// unit with no ownership check. Exposed publicly, those two would let anyone
// conjure matches and play anyone else's units. So there are two independent
// locks, and each one alone is enough:
//
//   1. `server/app.ts` only mounts this router when NODE_ENV !== "production"
//      (the same gate `server/devtools.ts` uses).
//   2. every request must carry `Authorization: Bearer $ADMIN_TOKEN`, matched
//      against the server process's own `ADMIN_TOKEN`. With no ADMIN_TOKEN set,
//      the routes answer 503 rather than opening — a missing secret must never
//      read as "no auth required".
//
// Note that nothing here reaches the turn mutation. `act` goes through
// `services/brain.ts` exactly as `POST /api/brain/act` does, so the boundary
// test in `server/services/applyTurn-boundary.test.ts` stays true.

import { and, asc, desc, eq, gt } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { matches, messages, players, rooms, rosterUnits, turns, units, users } from "../../shared/schema";
import { STARTER_UNITS } from "../../shared/starters";
import type { Action, Position } from "../../shared/engine";
import type { DbLike } from "../db/client";
import { bearerToken } from "../auth";
import { context } from "./context";
import * as brain from "../services/brain";
import { notifyMatchStarted, randomCode, startMatch } from "../services/rooms";

/** True only outside production. Mirrors `DEVTOOLS_ENABLED` in `devtools.ts`. */
export const DEV_ROUTES_ENABLED = process.env.NODE_ENV !== "production";

/**
 * The dev deployment's stand-in commander, used only when no real (Clerk) user
 * exists yet. Fixed clerkId so repeated seeds reuse the same row.
 */
const DEV_CLERK_ID = "dev-seed:solo-commander";

/**
 * Vite is unconfigured on `server.port` (see vite.config.ts), so this is the
 * port `bun run dev` serves the app on — not this server's own port.
 */
const DEV_ORIGIN = "http://localhost:5173";

function pickSquad(names: Array<string> | undefined) {
  if (!names) return STARTER_UNITS;
  return names.map((name) => {
    const unit = STARTER_UNITS.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!unit) {
      throw new Error(
        `No starter unit named "${name}". Available: ${STARTER_UNITS.map((s) => s.name).join(", ")}`,
      );
    }
    return unit;
  });
}

const targetOf = (action: Action): string | undefined => {
  if (action.kind === "attack") return action.targetUnitId;
  if (action.kind === "active" || action.kind === "consumable") return action.targetUnitId;
  return undefined;
};

/** The room's latest match, by code. Shared by `/find-match`. */
function findMatch(db: DbLike, code: string): { roomId: string; matchId: string } | null {
  const room = db.select().from(rooms).where(eq(rooms.code, code.toUpperCase())).get();
  if (!room) return null;
  const match = db
    .select({ _id: matches._id })
    .from(matches)
    .where(eq(matches.roomId, room._id))
    .orderBy(desc(matches._creationTime))
    .get();
  if (!match) return null;
  return { roomId: room._id, matchId: match._id };
}

export const devRoutes = new Elysia({ prefix: "/dev" })
  .use(context)
  // The token lock. `onBeforeHandle` on this instance covers every route below
  // it and nothing outside it.
  .onBeforeHandle(({ headers, status }) => {
    const expected = process.env.ADMIN_TOKEN;
    if (!expected) {
      return status(503, {
        error: "ADMIN_TOKEN is not set on the server — dev routes are closed.",
      });
    }
    if (bearerToken(headers.authorization) !== expected) {
      return status(401, { error: "Bad or missing dev admin token" });
    }
  })
  // ── POST /api/dev/seed-match ───────────────────────────────────────────
  // Fabricates a complete running match in one call: two players, two squads,
  // both ready, match started.
  //
  // BOTH PLAYER ROWS POINT AT THE SAME USER, on purpose. The browser's brain
  // loop (`src/components/MatchView.tsx`) only drives units whose player is the
  // signed-in user, and `POST /api/brain/act` gates on that same ownership — so
  // sharing the user is what lets ONE tab drive all six units. That is the whole
  // point of the harness. And if a real user exists it is that user, so the
  // seeded room shows up under their own account.
  .post(
    "/seed-match",
    ({ db, body }) => {
      const squads = { a: pickSquad(body.teamA), b: pickSquad(body.teamB) };
      for (const team of ["a", "b"] as const) {
        if (squads[team].length !== 3) throw new Error(`team${team.toUpperCase()} needs 3 units`);
      }

      // Prefer a real signed-in commander so the room is watchable in the
      // browser with their existing account.
      const known = db.select().from(users).limit(50).all();
      const real = known.find((u) => !u.clerkId.startsWith("dev-seed:"));
      const existing = known.find((u) => u.clerkId === DEV_CLERK_ID);

      const seeded = db.transaction((tx) => {
        const user =
          real ??
          existing ??
          tx
            .insert(users)
            .values({ clerkId: DEV_CLERK_ID, name: "Dev Commander" })
            .returning()
            .get();
        if (!user) throw new Error("Failed to create the dev commander");

        const code = randomCode();
        const room = tx.insert(rooms).values({ code, status: "lobby" }).returning().get();
        if (!room) throw new Error("Failed to create room");

        for (const team of ["a", "b"] as const) {
          const player = tx
            .insert(players)
            .values({
              roomId: room._id,
              userId: user._id,
              name: team === "a" ? user.name : `${user.name} (B)`,
              team,
              ready: true,
            })
            .returning()
            .get();
          if (!player) throw new Error("Failed to create player");
          for (const unit of squads[team]) {
            tx.insert(units)
              .values({
                roomId: room._id,
                playerId: player._id,
                team,
                ...unit,
                // Team B gets suffixed names: the brain resolves targets by
                // name, so two identically named units would be
                // indistinguishable to it.
                name: team === "a" ? unit.name : `${unit.name} II`,
                model: body.model ?? unit.model,
              })
              .run();
          }
        }

        // The SAME start path `setReady` uses — see `startMatch` in
        // `services/rooms.ts`. Never reimplemented here, or the harness would
        // drift away from what a real match looks like.
        const matchId = startMatch(tx, room._id, { gridSize: body.gridSize, seed: body.seed });
        return { roomId: room._id, matchId, code, playerName: user.name };
      });

      // Outside the transaction on purpose: see `notifyMatchStarted`.
      notifyMatchStarted(seeded.roomId, seeded.matchId, db);

      const url = `${DEV_ORIGIN}/room/${seeded.code}`;
      console.log(`seeded match for ${seeded.playerName} → ${url}`);
      return { ...seeded, url };
    },
    {
      body: t.Object({
        model: t.Optional(t.String()),
        gridSize: t.Optional(t.Number()),
        /** Fixed wall-generation seed → reproducible terrain. */
        seed: t.Optional(t.Number()),
        /** Starter unit names (from `shared/starters.ts`), 3 per side. */
        teamA: t.Optional(t.Array(t.String())),
        teamB: t.Optional(t.Array(t.String())),
      }),
    },
  )
  // ── POST /api/dev/act ──────────────────────────────────────────────────
  // The auth-free twin of `POST /api/brain/act`. It shares every line of brain
  // logic with the real path (`takeTurn`); only the "is this your unit?" check
  // is skipped, so the CLI can drive both teams with no Clerk session.
  //
  // Unlike the public route this AWAITS the turn and returns its result: the CLI
  // is a sequential driver with nothing subscribed to the socket, so the reply
  // is the only way it learns the turn finished.
  .post(
    "/act",
    async ({ db, body }) => {
      const ctxData = brain.unauthedTurnContext(db, body.matchId);
      if (!ctxData) return { status: "skipped" as const, reason: "no unit to play" };
      return await brain.takeTurn(db, body.matchId, body.apiKey, ctxData);
    },
    { body: t.Object({ matchId: t.String(), apiKey: t.String() }) },
  )
  // ── GET /api/dev/find-match?code=ABC123 ────────────────────────────────
  // Resolve a room code to its ids, for the driver script's `--room` flag.
  .get("/find-match", ({ db, query }) => findMatch(db, query.code), {
    query: t.Object({ code: t.String() }),
  })
  // ── GET /api/dev/match-trace ───────────────────────────────────────────
  // Everything `scripts/play-match.ts` needs for one trace step, in one round
  // trip. DEV ONLY: unlike `matches.teamMessages` this reveals BOTH teams' chat
  // mid-match, which is exactly what the secrecy boundary forbids on a real
  // route.
  .get(
    "/match-trace",
    ({ db, query }) => {
      const match = db.select().from(matches).where(eq(matches._id, query.matchId)).get();
      if (!match) throw new Error("Match not found");
      const roomUnits = db.select().from(units).where(eq(units.roomId, match.roomId)).all();
      const nameOf = new Map(roomUnits.map((u) => [u._id, u.name]));

      const played = db
        .select()
        .from(turns)
        .where(and(eq(turns.matchId, query.matchId), gt(turns.turnNumber, query.sinceTurn)))
        .orderBy(asc(turns.turnNumber))
        .all();
      const chat = db.select().from(messages).where(eq(messages.matchId, query.matchId)).all();
      const messageFor = new Map(chat.map((m) => [`${m.unitId}:${m.turnNumber}`, m.text]));

      return {
        status: match.status,
        turnNumber: match.turnNumber,
        roundNumber: match.roundNumber,
        turnCap: match.turnCap,
        gridSize: match.gridSize,
        winnerTeam: match.winnerTeam ?? undefined,
        currentUnitName: match.currentUnitId ? nameOf.get(match.currentUnitId) : undefined,
        units: roomUnits.map((u) => ({
          name: u.name,
          team: u.team,
          model: u.model,
          hp: u.hp ?? 0,
          alive: u.alive ?? false,
          position: u.position ?? undefined,
        })),
        turns: played.map((turn) => {
          const target = targetOf(turn.action);
          return {
            turnNumber: turn.turnNumber,
            unitName: nameOf.get(turn.unitId) ?? "?",
            team: roomUnits.find((u) => u._id === turn.unitId)?.team ?? ("a" as const),
            moveTo: (turn.moveTo ?? undefined) as Position | undefined,
            action: turn.action,
            targetName: target ? nameOf.get(target) : undefined,
            summary: turn.summary,
            thinking: turn.thinking ?? undefined,
            message: messageFor.get(`${turn.unitId}:${turn.turnNumber}`),
          };
        }),
      };
    },
    { query: t.Object({ matchId: t.String(), sinceTurn: t.Number() }) },
  )
  // ── POST /api/dev/wipe ─────────────────────────────────────────────────
  // Wipe all *game* data. `users` and `rosterUnits` are spared deliberately: a
  // wipe is for clearing out junk rooms between test runs, and deleting the
  // signed-in commander would take their saved squads with it and log the
  // browser into a stranger. Order is child-before-parent, so it works whether
  // or not FK cascades are on.
  .post("/wipe", ({ db }) => {
    let deleted = 0;
    db.transaction((tx) => {
      for (const table of [messages, turns, matches, units, players, rooms]) {
        deleted += tx.select({ _id: table._id }).from(table).all().length;
        tx.delete(table).run();
      }
    });
    return { deleted };
  })
  // ── POST /api/dev/set-all-models ───────────────────────────────────────
  // One-off: set every unit (roster + in-room) to a given model.
  .post(
    "/set-all-models",
    ({ db, body }) => {
      let updated = 0;
      db.transaction((tx) => {
        for (const table of [rosterUnits, units]) {
          updated += tx.select({ _id: table._id }).from(table).all().length;
          tx.update(table).set({ model: body.model }).run();
        }
      });
      return { updated };
    },
    { body: t.Object({ model: t.String() }) },
  );
