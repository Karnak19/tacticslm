import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { loadoutValidator } from "./schema";
import { CONSUMABLE_SLOTS, GRID_SIZE, TURN_CAP } from "./lib/catalog";
import { computeInitiative, generateWalls, resolveStats, spawnRows } from "./lib/engine";
import { toCatalog, toEngineUnit } from "./lib/db";
import { ensureUser, requireUser } from "./lib/auth";

const UNITS_PER_TEAM = 3;

function randomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

async function playerForUser(
  ctx: QueryCtx,
  roomId: Id<"rooms">,
  userId: Id<"users">,
): Promise<Doc<"players">> {
  const players = await ctx.db
    .query("players")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  const player = players.find((p) => p.userId === userId);
  if (!player) throw new Error("Not a player in this room");
  return player;
}

export const create = mutation({
  args: {},
  returns: v.object({ roomId: v.id("rooms"), code: v.string() }),
  handler: async (ctx) => {
    const user = await ensureUser(ctx);
    const code = randomCode();
    const roomId = await ctx.db.insert("rooms", { code, status: "lobby" });
    await ctx.db.insert("players", {
      roomId,
      userId: user._id,
      name: user.name,
      team: "a",
      ready: false,
    });
    return { roomId, code };
  },
});

export const join = mutation({
  args: { code: v.string() },
  returns: v.id("rooms"),
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_code", (q) => q.eq("code", args.code.toUpperCase()))
      .unique();
    if (!room) throw new Error("Room not found");
    const players = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", room._id))
      .collect();
    const existing = players.find((p) => p.userId === user._id);
    if (existing) return room._id; // rejoin
    if (room.status !== "lobby") throw new Error("Match already started");
    if (players.length >= 2) throw new Error("Room is full");
    await ctx.db.insert("players", {
      roomId: room._id,
      userId: user._id,
      name: user.name,
      team: "b",
      ready: false,
    });
    return room._id;
  },
});

// Replace the player's squad (3 units). Validates loadouts against the catalog.
export const setSquad = mutation({
  args: {
    roomId: v.id("rooms"),
    squad: v.array(
      v.object({
        name: v.string(),
        personality: v.string(),
        model: v.string(),
        loadout: loadoutValidator,
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room || room.status !== "lobby") throw new Error("Room is not in lobby");
    const user = await requireUser(ctx);
    const player = await playerForUser(ctx, args.roomId, user._id);
    if (args.squad.length !== UNITS_PER_TEAM) {
      throw new Error(`Squad must have exactly ${UNITS_PER_TEAM} units`);
    }

    const catalog = await toCatalog(ctx);
    for (const unit of args.squad) {
      const { loadout } = unit;
      for (const [slot, slug] of [
        ["weapon", loadout.weapon],
        ["helmet", loadout.helmet],
        ["chest", loadout.chest],
        ["boots", loadout.boots],
        ["active", loadout.active],
      ] as const) {
        const item = catalog.get(slug);
        if (!item || item.slot !== slot) throw new Error(`Invalid ${slot}: ${slug}`);
      }
      if (loadout.consumables.length !== CONSUMABLE_SLOTS) {
        throw new Error(`Pick exactly ${CONSUMABLE_SLOTS} consumables`);
      }
      for (const slug of loadout.consumables) {
        const item = catalog.get(slug);
        if (!item || item.slot !== "consumable") {
          throw new Error(`Invalid consumable: ${slug}`);
        }
      }
      // resolveStats throws on unknown items; also a sanity check
      resolveStats(loadout, catalog);
    }

    const existing = await ctx.db
      .query("units")
      .withIndex("by_player", (q) => q.eq("playerId", player._id))
      .collect();
    for (const u of existing) await ctx.db.delete(u._id);
    for (const unit of args.squad) {
      await ctx.db.insert("units", {
        roomId: args.roomId,
        playerId: player._id,
        team: player.team,
        ...unit,
      });
    }
    // Changing your squad un-readies you.
    await ctx.db.patch(player._id, { ready: false });
    return null;
  },
});

export const setReady = mutation({
  args: { roomId: v.id("rooms"), ready: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room || room.status !== "lobby") throw new Error("Room is not in lobby");
    const user = await requireUser(ctx);
    const player = await playerForUser(ctx, args.roomId, user._id);
    if (args.ready) {
      const units = await ctx.db
        .query("units")
        .withIndex("by_player", (q) => q.eq("playerId", player._id))
        .collect();
      if (units.length !== UNITS_PER_TEAM) throw new Error("Set your squad first");
    }
    await ctx.db.patch(player._id, { ready: args.ready });

    // Both players ready → start the match.
    const players = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();
    if (players.length === 2 && players.every((p) => p.ready)) {
      await startMatch(ctx, args.roomId);
    }
    return null;
  },
});

async function startMatch(ctx: MutationCtx, roomId: Id<"rooms">): Promise<void> {
  const units = await ctx.db
    .query("units")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  const catalog = await toCatalog(ctx);

  const seed = Math.floor(Math.random() * 2 ** 31);
  const walls = generateWalls(seed, GRID_SIZE);
  const rows = spawnRows(GRID_SIZE);

  // Spread each team across its spawn band.
  const spawnXs = [4, 8, 12];
  const byTeam = { a: units.filter((u) => u.team === "a"), b: units.filter((u) => u.team === "b") };
  for (const team of ["a", "b"] as const) {
    for (let i = 0; i < byTeam[team].length; i++) {
      const unit = byTeam[team][i];
      const stats = resolveStats(unit.loadout, catalog);
      await ctx.db.patch(unit._id, {
        position: { x: spawnXs[i], y: rows[team][0] },
        hp: stats.maxHp,
        alive: true,
        activeCooldown: 0,
        usedConsumables: [],
        lastActedRound: -1,
      });
    }
  }

  const refreshed = await ctx.db
    .query("units")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  const initiative = computeInitiative(refreshed.map(toEngineUnit), catalog) as Array<Id<"units">>;

  await ctx.db.insert("matches", {
    roomId,
    status: "running",
    walls,
    gridSize: GRID_SIZE,
    turnNumber: 0,
    roundNumber: 1,
    turnCap: TURN_CAP,
    initiative,
    initiativeIndex: 0,
    currentUnitId: initiative[0],
    effects: [],
  });
  await ctx.db.patch(roomId, { status: "active" });
}

// Lobby state for the room screen.
export const get = query({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room) return null;
    const players = await ctx.db
      .query("players")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();
    const units = await ctx.db
      .query("units")
      .withIndex("by_room", (q) => q.eq("roomId", args.roomId))
      .collect();
    return {
      room,
      players: players.map((p) => ({
        _id: p._id,
        name: p.name,
        team: p.team,
        ready: p.ready,
        unitCount: units.filter((u) => u.playerId === p._id).length,
      })),
    };
  },
});

export const byCode = query({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("rooms")
      .withIndex("by_code", (q) => q.eq("code", args.code.toUpperCase()))
      .unique();
  },
});
