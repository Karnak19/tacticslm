import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { actionValidator, positionValidator } from "./schema";
import { toCatalog, toSnapshot } from "./lib/db";
import { currentUser } from "./lib/auth";
import {
  type Action,
  checkWin,
  type Effect,
  IllegalAction,
  nextTurn,
  resolveStats,
  resolveTurn,
} from "./lib/engine";

const BASE_MESSAGE_BUDGET = 200; // characters; doubled by the strategist's circlet

async function roomUnits(ctx: QueryCtx, roomId: Id<"rooms">): Promise<Array<Doc<"units">>> {
  return await ctx.db
    .query("units")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
}

// Internal only: the brain action (convex/brain.ts) is the sole entry point for
// taking a turn — players cannot hand-craft actions, the LLM really is playing.
export const applyTurn = internalMutation({
  args: {
    matchId: v.id("matches"),
    unitId: v.id("units"),
    moveTo: v.optional(positionValidator),
    action: actionValidator,
    message: v.optional(v.string()),
    thinking: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const match = await ctx.db.get(args.matchId);
    if (!match || match.status !== "running") throw new Error("Match is not running");
    if (match.currentUnitId !== args.unitId) throw new Error("Not this unit's turn");

    const unit = await ctx.db.get(args.unitId);
    if (!unit) throw new Error("Unit not found");

    const units = await roomUnits(ctx, match.roomId);
    const catalog = await toCatalog(ctx);
    const snapshot = toSnapshot(match, units);

    let resolution;
    try {
      resolution = resolveTurn(snapshot, catalog, args.unitId, args.moveTo, args.action as Action);
    } catch (e) {
      if (e instanceof IllegalAction) throw new Error(`Illegal action: ${e.message}`);
      throw e;
    }
    const { snapshot: next, events } = resolution;

    // Persist unit state.
    for (const engineUnit of next.units) {
      await ctx.db.patch(engineUnit.id as Id<"units">, {
        position: engineUnit.position,
        hp: engineUnit.hp,
        alive: engineUnit.alive,
        activeCooldown: engineUnit.activeCooldown,
        usedConsumables: engineUnit.usedConsumables,
        lastActedRound: engineUnit.lastActedRound,
      });
    }

    // Record the turn (the replay).
    await ctx.db.insert("turns", {
      matchId: args.matchId,
      turnNumber: match.turnNumber,
      unitId: args.unitId,
      moveTo: args.moveTo,
      action: args.action,
      summary: events.join(" "),
      thinking: args.thinking?.slice(0, 500),
    });

    // Team chat, budget enforced server-side.
    if (args.message && args.message.trim().length > 0) {
      const stats = resolveStats(unit.loadout, catalog);
      const budget = BASE_MESSAGE_BUDGET * stats.messageBudgetMultiplier;
      await ctx.db.insert("messages", {
        matchId: args.matchId,
        unitId: args.unitId,
        team: unit.team,
        turnNumber: match.turnNumber,
        text: args.message.trim().slice(0, budget),
      });
    }

    // Win check before advancing.
    const win = checkWin(next, match.turnCap);
    if (win.finished) {
      await ctx.db.patch(args.matchId, {
        status: "finished",
        winnerTeam: win.winnerTeam,
        effects: next.effects as Doc<"matches">["effects"],
        turnNumber: match.turnNumber + 1,
        currentUnitId: undefined,
      });
      await ctx.db.patch(match.roomId, { status: "finished" });
      return null;
    }

    // Advance to the next living unit.
    const advance = nextTurn(
      match.initiative,
      match.initiativeIndex,
      match.roundNumber,
      next.units,
    );
    if (!advance) throw new Error("No living units to advance to");

    let effects = next.effects;
    if (advance.wrapped) {
      // New round: tick cooldowns, drop expired effects, re-check the round cap.
      for (const engineUnit of next.units) {
        if (engineUnit.alive && engineUnit.activeCooldown > 0) {
          await ctx.db.patch(engineUnit.id as Id<"units">, {
            activeCooldown: engineUnit.activeCooldown - 1,
          });
        }
      }
      effects = effects.filter((e: Effect) => e.expiresAfterRound >= advance.roundNumber);
      const cappedWin = checkWin({ ...next, roundNumber: advance.roundNumber }, match.turnCap);
      if (cappedWin.finished) {
        await ctx.db.patch(args.matchId, {
          status: "finished",
          winnerTeam: cappedWin.winnerTeam,
          effects: effects as Doc<"matches">["effects"],
          turnNumber: match.turnNumber + 1,
          roundNumber: advance.roundNumber,
          currentUnitId: undefined,
        });
        await ctx.db.patch(match.roomId, { status: "finished" });
        return null;
      }
    }

    await ctx.db.patch(args.matchId, {
      turnNumber: match.turnNumber + 1,
      roundNumber: advance.roundNumber,
      initiativeIndex: advance.index,
      currentUnitId: advance.unitId as Id<"units">,
      effects: effects as Doc<"matches">["effects"],
    });
    return null;
  },
});

// Live match state — everything both players may see (positions, HP, effects).
// Team chat is NOT here; see `teamMessages`.
export const byRoom = query({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, args) => {
    const match = await ctx.db
      .query("matches")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .order("desc")
      .first();
    if (!match) return null;
    const units = await ctx.db
      .query("units")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();
    return { match, units };
  },
});

// Team chat for the requesting player's team only.
export const teamMessages = query({
  args: { matchId: v.id("matches") },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (!user) return [];
    const match = await ctx.db.get(args.matchId);
    if (!match) return [];
    const players = await ctx.db
      .query("players")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const player = players.find((p) => p.roomId === match.roomId);
    if (!player) return [];
    return await ctx.db
      .query("messages")
      .withIndex("by_match_and_team", (q) => q.eq("matchId", args.matchId).eq("team", player.team))
      .collect();
  },
});

// Full replay: all turns and (once finished) both teams' messages.
export const replay = query({
  args: { matchId: v.id("matches") },
  handler: async (ctx, args) => {
    const match = await ctx.db.get(args.matchId);
    if (!match) return null;
    const turns = await ctx.db
      .query("turns")
      .withIndex("by_match", (q) => q.eq("matchId", args.matchId))
      .collect();
    const messages =
      match.status === "finished"
        ? await ctx.db
            .query("messages")
            .withIndex("by_match_and_team", (q) => q.eq("matchId", args.matchId))
            .collect()
        : [];
    return { match, turns, messages };
  },
});

// Forfeit: any player in the room can concede; the other team wins.
export const forfeit = mutation({
  args: { matchId: v.id("matches") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const match = await ctx.db.get(args.matchId);
    if (!match || match.status !== "running") throw new Error("Match is not running");
    const players = await ctx.db
      .query("players")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const player = players.find((p) => p.roomId === match.roomId);
    if (!player) throw new Error("Not a player in this room");

    await ctx.db.patch(args.matchId, {
      status: "finished",
      winnerTeam: player.team === "a" ? "b" : "a",
      currentUnitId: undefined,
    });
    await ctx.db.patch(match.roomId, { status: "finished" });
    return null;
  },
});
