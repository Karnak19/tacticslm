import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { actionValidator, positionValidator } from "./schema";
import { STARTER_UNITS } from "./lib/starters";
import { randomCode, startMatch } from "./rooms";
import { takeTurn, turnResultValidator } from "./brain";
import type { TurnContext, TurnResult } from "./brain";

// Dev utility: wipe all game data (keeps the item catalog and users).
// bunx convex run dev:wipe
export const wipe = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (const table of ["messages", "turns", "matches", "units", "players", "rooms"] as const) {
      const docs = await ctx.db.query(table).collect();
      for (const doc of docs) await ctx.db.delete(doc._id);
    }
    return null;
  },
});

// One-off: set every unit (roster + in-room) to a given model.
// bunx convex run dev:setAllModels '{"model":"nvidia/nemotron-3.5-lightning"}'
export const setAllModels = internalMutation({
  args: { model: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    let n = 0;
    for (const table of ["rosterUnits", "units"] as const) {
      for (const doc of await ctx.db.query(table).collect()) {
        await ctx.db.patch(doc._id, { model: args.model });
        n++;
      }
    }
    return n;
  },
});

// The dev deployment's stand-in commander, used only when no real (Clerk) user
// exists yet. Fixed clerkId so repeated seeds reuse the same row.
const DEV_CLERK_ID = "dev-seed:solo-commander";

// Vite is unconfigured on `server.port` (see vite.config.ts), so this is the
// port `bun run dev` serves on.
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

// ---------------------------------------------------------------------------
// DEV ONLY — internal on purpose. `seedMatch` fabricates a running match with
// no auth and no ready handshake, so it must never be reachable by a real
// player (that is why it is an internalMutation and not a mutation).
//
//   bunx convex run dev:seedMatch
//   bunx convex run dev:seedMatch '{"model":"nvidia/nemotron-3.5-lightning","gridSize":10}'
//   bunx convex run dev:seedMatch '{"teamA":["Bastion","Whisper","Havoc"],"teamB":["Havoc","Havoc","Havoc"]}'
//
// Both player rows point at the SAME user on purpose: the browser's brain loop
// (src/components/MatchView.tsx) only drives units whose player is the signed-in
// user, so sharing the user makes one tab drive both teams — the whole point of
// the harness. If a real user exists it is that user, so the seeded room shows
// up under their own account.
// ---------------------------------------------------------------------------
export const seedMatch = internalMutation({
  args: {
    model: v.optional(v.string()),
    gridSize: v.optional(v.number()),
    seed: v.optional(v.number()),
    // Starter unit names (from convex/lib/starters.ts), 3 per side.
    teamA: v.optional(v.array(v.string())),
    teamB: v.optional(v.array(v.string())),
  },
  returns: v.object({
    roomId: v.id("rooms"),
    matchId: v.id("matches"),
    code: v.string(),
    url: v.string(),
    playerName: v.string(),
  }),
  handler: async (ctx, args) => {
    const anyItem = await ctx.db.query("items").take(1);
    if (anyItem.length === 0) {
      throw new Error("Item catalog is empty — run `bunx convex run items:seed` first");
    }

    const squads = { a: pickSquad(args.teamA), b: pickSquad(args.teamB) };
    for (const team of ["a", "b"] as const) {
      if (squads[team].length !== 3) throw new Error(`team${team.toUpperCase()} needs 3 units`);
    }

    // Prefer a real signed-in commander so the room is watchable in the browser
    // with their existing account.
    const users = await ctx.db.query("users").take(50);
    const real = users.find((u) => !u.clerkId.startsWith("dev-seed:"));
    let user: Doc<"users">;
    if (real) {
      user = real;
    } else {
      const existing = users.find((u) => u.clerkId === DEV_CLERK_ID);
      user =
        existing ??
        (await ctx.db.get(
          await ctx.db.insert("users", { clerkId: DEV_CLERK_ID, name: "Dev Commander" }),
        ))!;
    }

    const code = randomCode();
    const roomId = await ctx.db.insert("rooms", { code, status: "lobby" });
    for (const team of ["a", "b"] as const) {
      const playerId = await ctx.db.insert("players", {
        roomId,
        userId: user._id,
        name: team === "a" ? user.name : `${user.name} (B)`,
        team,
        ready: true,
      });
      for (const unit of squads[team]) {
        await ctx.db.insert("units", {
          roomId,
          playerId,
          team,
          ...unit,
          // Team B gets suffixed names: the brain resolves targets by name, so
          // two identically named units would be indistinguishable to it.
          name: team === "a" ? unit.name : `${unit.name} II`,
          model: args.model ?? unit.model,
        });
      }
    }

    // Same start path as `rooms.setReady` — the seeded state cannot drift.
    const matchId = await startMatch(ctx, roomId, { gridSize: args.gridSize, seed: args.seed });

    const url = `${DEV_ORIGIN}/room/${code}`;
    console.log(`seeded match for ${user.name} → ${url}`);
    return { roomId, matchId, code, url, playerName: user.name };
  },
});

// Resolve a room code to its ids, for the driver script's `--room` flag.
// bunx convex run dev:findMatch '{"code":"ABC123"}'
export const findMatch = internalQuery({
  args: { code: v.string() },
  returns: v.union(v.null(), v.object({ roomId: v.id("rooms"), matchId: v.id("matches") })),
  handler: async (ctx, args) => {
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_code", (q) => q.eq("code", args.code.toUpperCase()))
      .unique();
    if (!room) return null;
    const match = await ctx.db
      .query("matches")
      .withIndex("by_room", (q) => q.eq("roomId", room._id))
      .order("desc")
      .first();
    if (!match) return null;
    return { roomId: room._id, matchId: match._id };
  },
});

// Everything scripts/play-match.ts needs for one trace step, in one round trip.
// DEV ONLY: unlike `matches.teamMessages` this reveals BOTH teams' chat mid-match.
export const matchTrace = internalQuery({
  args: { matchId: v.id("matches"), sinceTurn: v.number() },
  returns: v.object({
    status: v.union(v.literal("running"), v.literal("finished")),
    turnNumber: v.number(),
    roundNumber: v.number(),
    turnCap: v.number(),
    gridSize: v.number(),
    winnerTeam: v.optional(v.union(v.literal("a"), v.literal("b"), v.literal("draw"))),
    currentUnitName: v.optional(v.string()),
    units: v.array(
      v.object({
        name: v.string(),
        team: v.union(v.literal("a"), v.literal("b")),
        model: v.string(),
        hp: v.number(),
        alive: v.boolean(),
        position: v.optional(positionValidator),
      }),
    ),
    turns: v.array(
      v.object({
        turnNumber: v.number(),
        unitName: v.string(),
        team: v.union(v.literal("a"), v.literal("b")),
        moveTo: v.optional(positionValidator),
        action: actionValidator,
        targetName: v.optional(v.string()),
        summary: v.string(),
        thinking: v.optional(v.string()),
        message: v.optional(v.string()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const match = await ctx.db.get(args.matchId);
    if (!match) throw new Error("Match not found");
    const units = await ctx.db
      .query("units")
      .withIndex("by_room", (q) => q.eq("roomId", match.roomId))
      .collect();
    const nameOf = new Map(units.map((u) => [u._id as string, u.name]));

    const turns = await ctx.db
      .query("turns")
      .withIndex("by_match", (q) => q.eq("matchId", args.matchId).gt("turnNumber", args.sinceTurn))
      .collect();
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_match_and_team", (q) => q.eq("matchId", args.matchId))
      .collect();
    const messageFor = new Map(messages.map((m) => [`${m.unitId}:${m.turnNumber}`, m.text]));

    const targetOf = (action: Doc<"turns">["action"]): Id<"units"> | undefined => {
      if (action.kind === "attack") return action.targetUnitId;
      if (action.kind === "active" || action.kind === "consumable") return action.targetUnitId;
      return undefined;
    };

    return {
      status: match.status,
      turnNumber: match.turnNumber,
      roundNumber: match.roundNumber,
      turnCap: match.turnCap,
      gridSize: match.gridSize,
      winnerTeam: match.winnerTeam,
      currentUnitName: match.currentUnitId ? nameOf.get(match.currentUnitId) : undefined,
      units: units.map((u) => ({
        name: u.name,
        team: u.team,
        model: u.model,
        hp: u.hp ?? 0,
        alive: u.alive ?? false,
        position: u.position,
      })),
      turns: turns.map((t) => {
        const target = targetOf(t.action);
        return {
          turnNumber: t.turnNumber,
          unitName: nameOf.get(t.unitId) ?? "?",
          team: units.find((u) => u._id === t.unitId)?.team ?? "a",
          moveTo: t.moveTo,
          action: t.action,
          targetName: target ? nameOf.get(target) : undefined,
          summary: t.summary,
          thinking: t.thinking,
          message: messageFor.get(`${t.unitId}:${t.turnNumber}`),
        };
      }),
    };
  },
});

// DEV ONLY — the auth-free twin of the public `brain.act`. It shares every line
// of brain logic with the real path (`takeTurn`); only the "is this your unit?"
// check is skipped, so the CLI can drive both teams without a Clerk session.
// Internal on purpose: publicly reachable, this would let anyone play anyone
// else's units.
//   bunx convex run dev:act '{"matchId":"...","apiKey":"sk-or-..."}'
export const act = internalAction({
  args: { matchId: v.id("matches"), apiKey: v.string() },
  returns: turnResultValidator,
  handler: async (ctx, args): Promise<TurnResult> => {
    const ctxData: TurnContext | null = await ctx.runQuery(internal.brain.unauthedTurnContext, {
      matchId: args.matchId,
    });
    if (!ctxData) return { status: "skipped" as const, reason: "no unit to play" };
    return await takeTurn(ctx, args.matchId, args.apiKey, ctxData);
  },
});
