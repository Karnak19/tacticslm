import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { CONSUMABLE_SLOTS } from "../../shared/catalog";
import { matches, players, rooms, rosterUnits, units, users } from "../../shared/schema";
import type { User } from "../../shared/types";
import { STARTER_UNITS } from "../../shared/starters";
import { byCode, create, get, join, latestMatchId, setReady, setSquad } from "./rooms";
import { freshDb, type Harness } from "./testing";

let h: Harness;
let alice: User;
let bob: User;

function commander(clerkId: string, name: string): User {
  const [user] = h.db.insert(users).values({ clerkId, name }).returning().all();
  h.db
    .insert(rosterUnits)
    .values(STARTER_UNITS.map((unit) => ({ userId: user._id, ...unit })))
    .run();
  return user;
}

function rosterIds(user: User): Array<string> {
  return h.db
    .select({ _id: rosterUnits._id })
    .from(rosterUnits)
    .where(eq(rosterUnits.userId, user._id))
    .all()
    .map((r) => r._id);
}

beforeEach(() => {
  h = freshDb();
  alice = commander("clerk_alice", "Alice");
  bob = commander("clerk_bob", "Bob");
});
afterEach(() => h.cleanup());

test("create puts the host on team a", () => {
  const { roomId, code } = create(h.db, alice);
  expect(code).toHaveLength(6);
  expect(byCode(h.db, code)!._id).toBe(roomId);
  const roster = get(h.db, roomId)!;
  expect(roster.room.status).toBe("lobby");
  expect(roster.players).toEqual([
    { _id: roster.players[0]._id, name: "Alice", team: "a", ready: false, unitCount: 0 },
  ]);
});

test("join puts the second commander on team b, and is idempotent", () => {
  const { roomId, code } = create(h.db, alice);
  expect(join(h.db, bob, code.toLowerCase())).toBe(roomId);
  expect(join(h.db, bob, code)).toBe(roomId); // rejoin, not a duplicate
  expect(h.db.select().from(players).where(eq(players.roomId, roomId)).all()).toHaveLength(2);
});

test("a third commander is turned away", () => {
  const { code } = create(h.db, alice);
  join(h.db, bob, code);
  const carol = commander("clerk_carol", "Carol");
  expect(() => join(h.db, carol, code)).toThrow("Room is full");
});

test("join fails on an unknown code", () => {
  expect(() => join(h.db, alice, "ZZZZZZ")).toThrow("Room not found");
});

test("setSquad copies exactly three roster units into the room", () => {
  const { roomId } = create(h.db, alice);
  setSquad(h.db, alice, roomId, rosterIds(alice));
  const squad = h.db.select().from(units).where(eq(units.roomId, roomId)).all();
  expect(squad).toHaveLength(3);
  expect(squad.every((u) => u.team === "a")).toBe(true);
  expect(squad[0].loadout.consumables).toHaveLength(CONSUMABLE_SLOTS);
});

test("setSquad rejects duplicates, wrong counts and other people's units", () => {
  const { roomId } = create(h.db, alice);
  const ids = rosterIds(alice);
  expect(() => setSquad(h.db, alice, roomId, [ids[0], ids[0], ids[1]])).toThrow(
    "Pick exactly 3 different units",
  );
  expect(() => setSquad(h.db, alice, roomId, ids.slice(0, 2))).toThrow(
    "Pick exactly 3 different units",
  );
  expect(() => setSquad(h.db, alice, roomId, rosterIds(bob))).toThrow("Not your unit");
  // Nothing was written by any of the failures.
  expect(h.db.select().from(units).where(eq(units.roomId, roomId)).all()).toHaveLength(0);
});

test("changing your squad un-readies you", () => {
  const { roomId } = create(h.db, alice);
  setSquad(h.db, alice, roomId, rosterIds(alice));
  setReady(h.db, alice, roomId, true);
  setSquad(h.db, alice, roomId, rosterIds(alice));
  expect(get(h.db, roomId)!.players[0].ready).toBe(false);
});

test("readying without a squad is refused", () => {
  const { roomId } = create(h.db, alice);
  expect(() => setReady(h.db, alice, roomId, true)).toThrow("Set your squad first");
});

test("both players ready starts exactly one match, in one transaction", () => {
  const { roomId, code } = create(h.db, alice);
  join(h.db, bob, code);
  setSquad(h.db, alice, roomId, rosterIds(alice));
  setSquad(h.db, bob, roomId, rosterIds(bob));

  expect(setReady(h.db, alice, roomId, true)).toBeNull(); // one side is not enough
  const matchId = setReady(h.db, bob, roomId, true);
  expect(matchId).not.toBeNull();

  expect(h.db.select().from(matches).where(eq(matches.roomId, roomId)).all()).toHaveLength(1);
  expect(latestMatchId(h.db, roomId)).toBe(matchId);

  const match = h.db.select().from(matches).where(eq(matches._id, matchId!)).get()!;
  expect(match.status).toBe("running");
  expect(match.roundNumber).toBe(1);
  expect(match.turnNumber).toBe(0);
  expect(match.initiative).toHaveLength(6);
  expect(match.currentUnitId).toBe(match.initiative[0]);
  expect(match.walls.length).toBeGreaterThan(0);

  // The room left the lobby, so nobody can un-ready their way back in.
  expect(h.db.select().from(rooms).where(eq(rooms._id, roomId)).get()!.status).toBe("active");
  expect(() => setReady(h.db, alice, roomId, false)).toThrow("Room is not in lobby");
  expect(() => setSquad(h.db, alice, roomId, rosterIds(alice))).toThrow("Room is not in lobby");
});

test("startMatch spawns every unit with full HP on its own row", () => {
  const { roomId, code } = create(h.db, alice);
  join(h.db, bob, code);
  setSquad(h.db, alice, roomId, rosterIds(alice));
  setSquad(h.db, bob, roomId, rosterIds(bob));
  setReady(h.db, alice, roomId, true);
  setReady(h.db, bob, roomId, true);

  const spawned = h.db.select().from(units).where(eq(units.roomId, roomId)).all();
  expect(spawned).toHaveLength(6);
  for (const unit of spawned) {
    expect(unit.alive).toBe(true);
    expect(unit.hp).toBeGreaterThan(0);
    expect(unit.activeCooldown).toBe(0);
    expect(unit.usedConsumables).toEqual([]);
    expect(unit.lastActedRound).toBe(-1);
  }
  // Teams start on different rows.
  const rowsA = new Set(spawned.filter((u) => u.team === "a").map((u) => u.position!.y));
  const rowsB = new Set(spawned.filter((u) => u.team === "b").map((u) => u.position!.y));
  expect([...rowsA].some((y) => rowsB.has(y))).toBe(false);
});

test("a non-player cannot touch the room", () => {
  const { roomId } = create(h.db, alice);
  expect(() => setSquad(h.db, bob, roomId, rosterIds(bob))).toThrow("Not a player in this room");
  expect(() => setReady(h.db, bob, roomId, false)).toThrow("Not a player in this room");
});
