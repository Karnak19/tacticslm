// Lobby and match-start service. Port of `convex/rooms.ts`.
//
// Shape change from Convex: these are plain async functions taking `(db, user,
// …)` instead of mutations reading their caller out of `ctx`. Authentication
// happens once, at the edge (`server/auth.ts`), and the resolved `User` is passed
// in — so `ensureUser` no longer runs inside every mutation.

import { and, desc, eq } from "drizzle-orm";
import { CONSUMABLE_SLOTS, GRID_SIZE, TURN_CAP } from "../../shared/catalog";
import { computeInitiative, generateWalls, resolveStats, spawnRows } from "../../shared/engine";
import { matches, players, rooms, rosterUnits, units } from "../../shared/schema";
import type { Player, Room, User } from "../../shared/types";
import { getDb, type Db, type DbLike } from "../db/client";
import { publishRoom } from "./broadcast";
import { CATALOG_MAP, toEngineUnit } from "./mappers";

const UNITS_PER_TEAM = 3;

export function randomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function playerForUser(db: DbLike, roomId: string, userId: string): Player {
  const player = db
    .select()
    .from(players)
    .where(and(eq(players.roomId, roomId), eq(players.userId, userId)))
    .get();
  if (!player) throw new Error("Not a player in this room");
  return player;
}

/**
 * Announce a started match to everyone in the room.
 *
 * WHY IT IS OUTSIDE THE TRANSACTION: broadcasting from inside `db.transaction`
 * would tell both clients a match had begun that a later rollback un-starts,
 * and there is no un-send. Convex never had this problem — subscribers only ever
 * observed committed state — so the call site is deliberately placed after the
 * commit and this function trusts that.
 *
 * WHY IT IS IDEMPOTENT: there are two call sites. `setReady` calls it (that is
 * the correct one, immediately post-commit), and `server/routes/rooms.ts` calls
 * it again on the returned `matchId`. Rather than reach into the route layer to
 * delete a line, the second call is absorbed here: a match starts once, so
 * announcing it twice is always the bug, never the intent. The ledger is
 * trimmed so a long-lived process does not accumulate one entry per match
 * forever.
 */
const announced = new Set<string>();
const ANNOUNCED_LIMIT = 1000;

export function notifyMatchStarted(roomId: string, matchId: string, db: DbLike = getDb()): void {
  if (announced.has(matchId)) return;
  if (announced.size >= ANNOUNCED_LIMIT) announced.clear();
  announced.add(matchId);

  const match = db.select().from(matches).where(eq(matches._id, matchId)).get();
  if (!match) return;
  publishRoom(roomId, {
    type: "match:start",
    roomId,
    matchId,
    match,
    units: db.select().from(units).where(eq(units.roomId, roomId)).all(),
  });
  publishLobby(db, roomId);
}

/**
 * Push the lobby snapshot every room screen renders from. Same shape `GET
 * /api/rooms/:id` returns, so a socket update and a reconnect re-fetch can never
 * disagree.
 */
export function publishLobby(db: DbLike, roomId: string): void {
  const state = get(db, roomId);
  if (!state) return;
  publishRoom(roomId, { type: "lobby:update", roomId, room: state.room, players: state.players });
}

export function create(db: Db, user: User): { roomId: string; code: string } {
  return db.transaction((tx) => {
    const code = randomCode();
    const room = tx.insert(rooms).values({ code, status: "lobby" }).returning().get();
    if (!room) throw new Error("Failed to create room");
    tx.insert(players)
      .values({ roomId: room._id, userId: user._id, name: user.name, team: "a", ready: false })
      .run();
    return { roomId: room._id, code };
  });
}

export function join(db: Db, user: User, code: string): string {
  const roomId = db.transaction((tx) => {
    const room = tx.select().from(rooms).where(eq(rooms.code, code.toUpperCase())).get();
    if (!room) throw new Error("Room not found");
    const roster = tx.select().from(players).where(eq(players.roomId, room._id)).all();
    const existing = roster.find((p) => p.userId === user._id);
    if (existing) return room._id; // rejoin
    if (room.status !== "lobby") throw new Error("Match already started");
    if (roster.length >= 2) throw new Error("Room is full");
    tx.insert(players)
      .values({ roomId: room._id, userId: user._id, name: user.name, team: "b", ready: false })
      .run();
    return room._id;
  });
  publishLobby(db, roomId);
  return roomId;
}

/**
 * Pick the squad: 3 distinct units from the player's roster. The roster is the
 * single source of unit definitions; this copies them into the room.
 */
export function setSquad(db: Db, user: User, roomId: string, rosterUnitIds: Array<string>): void {
  db.transaction((tx) => {
    const room = tx.select().from(rooms).where(eq(rooms._id, roomId)).get();
    if (!room || room.status !== "lobby") throw new Error("Room is not in lobby");
    const player = playerForUser(tx, roomId, user._id);
    if (new Set(rosterUnitIds).size !== UNITS_PER_TEAM) {
      throw new Error(`Pick exactly ${UNITS_PER_TEAM} different units`);
    }

    const squad = [];
    for (const id of rosterUnitIds) {
      const rosterUnit = tx.select().from(rosterUnits).where(eq(rosterUnits._id, id)).get();
      if (!rosterUnit || rosterUnit.userId !== user._id) {
        throw new Error("Not your unit");
      }
      const { loadout } = rosterUnit;
      if (loadout.consumables.length !== CONSUMABLE_SLOTS) {
        throw new Error(`${rosterUnit.name}: pick exactly ${CONSUMABLE_SLOTS} consumables`);
      }
      resolveStats(loadout, CATALOG_MAP); // throws on unknown/invalid items
      squad.push({
        name: rosterUnit.name,
        personality: rosterUnit.personality,
        model: rosterUnit.model,
        skin: rosterUnit.skin,
        loadout,
      });
    }

    tx.delete(units).where(eq(units.playerId, player._id)).run();
    tx.insert(units)
      .values(squad.map((unit) => ({ roomId, playerId: player._id, team: player.team, ...unit })))
      .run();
    // Changing your squad un-readies you.
    tx.update(players).set({ ready: false }).where(eq(players._id, player._id)).run();
  });
  publishLobby(db, roomId);
}

/**
 * Toggle readiness, and start the match when both players are ready.
 *
 * The readiness write and the match start are ONE transaction. In Convex they
 * were one serializable mutation; splitting them here would let both players'
 * final `setReady` calls each see two ready players and each call `startMatch`,
 * producing two matches for one room. Returns the new match id when it started.
 */
export function setReady(db: Db, user: User, roomId: string, ready: boolean): string | null {
  const matchId = db.transaction((tx) => {
    const room = tx.select().from(rooms).where(eq(rooms._id, roomId)).get();
    if (!room || room.status !== "lobby") throw new Error("Room is not in lobby");
    const player = playerForUser(tx, roomId, user._id);
    if (ready) {
      const own = tx.select().from(units).where(eq(units.playerId, player._id)).all();
      if (own.length !== UNITS_PER_TEAM) throw new Error("Set your squad first");
    }
    tx.update(players).set({ ready }).where(eq(players._id, player._id)).run();

    // Both players ready → start the match.
    const roster = tx.select().from(players).where(eq(players.roomId, roomId)).all();
    if (roster.length === 2 && roster.every((p) => p.ready)) {
      return startMatch(tx, roomId);
    }
    return null;
  });
  // Outside the transaction on purpose: see `notifyMatchStarted`.
  if (matchId) notifyMatchStarted(roomId, matchId, db);
  else publishLobby(db, roomId);
  return matchId;
}

/**
 * The single start path: spawns both squads, computes initiative, inserts the
 * match and flips the room to `active`. `setReady` calls it when both players are
 * ready; the dev seed harness calls it too, so the harness produces state
 * identical in shape to a real match.
 *
 * Synchronous, and takes a `DbLike` rather than the `Db`, so it can be composed
 * into a caller's transaction (which is what makes `setReady` atomic).
 */
export function startMatch(
  tx: DbLike,
  roomId: string,
  opts?: { gridSize?: number; seed?: number },
): string {
  const gridSize = opts?.gridSize ?? GRID_SIZE;
  const roomUnits = tx.select().from(units).where(eq(units.roomId, roomId)).all();

  const seed = opts?.seed ?? Math.floor(Math.random() * 2 ** 31);
  const walls = generateWalls(seed, gridSize);
  const rows = spawnRows(gridSize);

  // Spread each team across its spawn band.
  const spawnXs = [1, 2, 3].map((i) => Math.round((gridSize * i) / 4));
  const byTeam = {
    a: roomUnits.filter((u) => u.team === "a"),
    b: roomUnits.filter((u) => u.team === "b"),
  };
  for (const team of ["a", "b"] as const) {
    for (let i = 0; i < byTeam[team].length; i++) {
      const unit = byTeam[team][i];
      const stats = resolveStats(unit.loadout, CATALOG_MAP);
      tx.update(units)
        .set({
          position: { x: spawnXs[i], y: rows[team][0] },
          hp: stats.maxHp,
          alive: true,
          activeCooldown: 0,
          usedConsumables: [],
          lastActedRound: -1,
        })
        .where(eq(units._id, unit._id))
        .run();
    }
  }

  const refreshed = tx.select().from(units).where(eq(units.roomId, roomId)).all();
  const initiative = computeInitiative(refreshed.map(toEngineUnit), CATALOG_MAP);

  const match = tx
    .insert(matches)
    .values({
      roomId,
      status: "running",
      walls,
      gridSize,
      turnNumber: 0,
      roundNumber: 1,
      turnCap: TURN_CAP,
      initiative,
      initiativeIndex: 0,
      currentUnitId: initiative[0],
      effects: [],
    })
    .returning()
    .get();
  if (!match) throw new Error("Failed to create match");
  tx.update(rooms).set({ status: "active" }).where(eq(rooms._id, roomId)).run();
  return match._id;
}

/** Lobby state for the room screen. */
export function get(
  db: DbLike,
  roomId: string,
): {
  room: Room;
  players: Array<{ _id: string; name: string; team: "a" | "b"; ready: boolean; unitCount: number }>;
} | null {
  const room = db.select().from(rooms).where(eq(rooms._id, roomId)).get();
  if (!room) return null;
  const roster = db.select().from(players).where(eq(players.roomId, roomId)).all();
  const roomUnits = db.select().from(units).where(eq(units.roomId, roomId)).all();
  return {
    room,
    players: roster.map((p) => ({
      _id: p._id,
      name: p.name,
      team: p.team,
      ready: p.ready,
      unitCount: roomUnits.filter((u) => u.playerId === p._id).length,
    })),
  };
}

export function byCode(db: DbLike, code: string): Room | null {
  return db.select().from(rooms).where(eq(rooms.code, code.toUpperCase())).get() ?? null;
}

/** The room's latest match, if any. Used by the match screen and the brain loop. */
export function latestMatchId(db: DbLike, roomId: string): string | null {
  const match = db
    .select({ _id: matches._id })
    .from(matches)
    .where(eq(matches.roomId, roomId))
    .orderBy(desc(matches._creationTime))
    .get();
  return match?._id ?? null;
}
