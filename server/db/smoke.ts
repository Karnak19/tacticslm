/**
 * Round-trip self-check for the schema: `bun server/db/smoke.ts`.
 *
 * Builds a whole match in a scratch database — user, room, two players, six
 * units with loadouts and positions, a match with walls/effects/initiative, a
 * turn with a JSON action, a message — then reads it all back and asserts the
 * JSON columns came out as real objects with the right shapes. Nothing else in
 * the app imports this file; it exists so the schema stays honest.
 */

import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { and, asc, eq } from "drizzle-orm";
import { rmSync } from "node:fs";
import { createDb } from "./client";
import {
  matches,
  messages,
  players,
  rooms,
  rosterUnits,
  turns,
  units,
  users,
} from "../../shared/schema";
import type { Action, Effect, Loadout, Position } from "../../shared/engine";

const DB_FILE = "data/smoke.db";

function assert(ok: boolean, what: string): void {
  if (!ok) throw new Error(`smoke: ${what}`);
  console.log(`  ok  ${what}`);
}

for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB_FILE}${suffix}`, { force: true });

const db = createDb(DB_FILE);
migrate(db, { migrationsFolder: "server/db/migrations" });

const loadout: Loadout = {
  weapon: "rifle",
  helmet: "visor",
  chest: "plate",
  boots: "sprint_boots",
  active: "smoke_grenade",
  consumables: ["medkit", "stim"],
};

const [user] = await db.insert(users).values({ clerkId: "user_smoke", name: "Smoke" }).returning();
if (!user) throw new Error("smoke: no user");

const [roster] = await db
  .insert(rosterUnits)
  .values({ userId: user._id, name: "Saved build", personality: "calm", model: "x", loadout })
  .returning();
if (!roster) throw new Error("smoke: no roster unit");

const [room] = await db.insert(rooms).values({ code: "SMOKE", status: "lobby" }).returning();
if (!room) throw new Error("smoke: no room");

const insertedPlayers = await db
  .insert(players)
  .values([
    { roomId: room._id, userId: user._id, name: "A", team: "a", ready: true },
    { roomId: room._id, userId: user._id, name: "B", team: "b", ready: false },
  ])
  .returning();
const [pa, pb] = insertedPlayers;
if (!pa || !pb) throw new Error("smoke: no players");

const insertedUnits = await db
  .insert(units)
  .values(
    [0, 1, 2, 3, 4, 5].map((i) => {
      const onTeamA = i < 3;
      return {
        roomId: room._id,
        playerId: onTeamA ? pa._id : pb._id,
        team: (onTeamA ? "a" : "b") as "a" | "b",
        name: `unit-${i}`,
        personality: "aggressive",
        model: "deepseek-v4-flash",
        skin: i === 0 ? null : "ranger",
        loadout,
        position: { x: i, y: onTeamA ? 0 : 11 } satisfies Position,
        hp: 20,
        alive: true,
        activeCooldown: 0,
        usedConsumables: i === 0 ? ["medkit"] : [],
        lastActedRound: -1,
      };
    }),
  )
  .returning();
assert(insertedUnits.length === 6, "six units inserted");

// A unit that has not entered a match: hp / position / alive stay null, which is
// exactly the distinction `toEngineUnit`'s `?? 0` / `?? false` relies on.
const [benched] = await db
  .insert(units)
  .values({
    roomId: room._id,
    playerId: pa._id,
    team: "a",
    name: "benched",
    personality: "shy",
    model: "deepseek-v4-flash",
    loadout,
  })
  .returning();
if (!benched) throw new Error("smoke: no benched unit");
assert(
  benched.hp === null && benched.position === null && benched.alive === null,
  "pre-match unit keeps hp/position/alive null",
);

const walls: Array<Position> = [
  { x: 4, y: 4 },
  { x: 5, y: 4 },
];
const effects: Array<Effect> = [
  { kind: "smoke", cells: [{ x: 6, y: 6 }], expiresAfterRound: 3 },
  {
    kind: "taunt",
    sourceUnitId: insertedUnits[0]!._id,
    affectedUnitIds: [insertedUnits[3]!._id, insertedUnits[4]!._id],
    expiresAfterRound: 2,
  },
  { kind: "shielded", unitId: insertedUnits[1]!._id, expiresAfterRound: 1 },
];
const initiative = insertedUnits.map((u) => u._id);

const [match] = await db
  .insert(matches)
  .values({
    roomId: room._id,
    status: "running",
    walls,
    gridSize: 12,
    turnNumber: 1,
    roundNumber: 1,
    turnCap: 10,
    initiative,
    initiativeIndex: 0,
    currentUnitId: initiative[0],
    effects,
    winnerTeam: null,
  })
  .returning();
if (!match) throw new Error("smoke: no match");

const action: Action = { kind: "consumable", slug: "medkit", targetUnitId: insertedUnits[1]!._id };
const [turn] = await db
  .insert(turns)
  .values({
    matchId: match._id,
    turnNumber: 1,
    unitId: insertedUnits[0]!._id,
    moveTo: { x: 1, y: 1 },
    action,
    summary: "unit-0 healed unit-1 for 6",
    thinking: "ally is low, top them up before pushing",
  })
  .returning();
if (!turn) throw new Error("smoke: no turn");

await db.insert(messages).values({
  matchId: match._id,
  unitId: insertedUnits[0]!._id,
  team: "a",
  turnNumber: 1,
  text: "holding the left lane",
});

// --- read everything back through fresh queries ---

const readMatch = await db.query.matches.findFirst({ where: eq(matches._id, match._id) });
if (!readMatch) throw new Error("smoke: match vanished");

assert(
  Array.isArray(readMatch.walls) && readMatch.walls[0]?.x === 4,
  "matches.walls is Position[]",
);
assert(readMatch.initiative.length === 6, "matches.initiative is a 6-id array");
assert(readMatch.effects.length === 3, "matches.effects has three entries");

const smokeEffect = readMatch.effects.find((e) => e.kind === "smoke");
assert(
  smokeEffect?.kind === "smoke" && smokeEffect.cells[0]?.y === 6,
  "smoke effect keeps its cells",
);
const taunt = readMatch.effects.find((e) => e.kind === "taunt");
assert(taunt?.kind === "taunt" && taunt.affectedUnitIds.length === 2, "taunt effect keeps its ids");
assert(readMatch.winnerTeam === null, "matches.winnerTeam nullable");
assert(readMatch.currentUnitId === initiative[0], "matches.currentUnitId round-trips");
assert(
  typeof readMatch._creationTime === "number" && readMatch._creationTime > 0,
  "_creationTime stamped",
);
assert(typeof readMatch._id === "string" && readMatch._id.length > 0, "_id is a generated string");

const teamAUnits = await db
  .select()
  .from(units)
  .where(and(eq(units.roomId, room._id), eq(units.team, "a")));
assert(teamAUnits.length === 4, "four team-a units (three fielded plus the benched one)");

const readUnit = teamAUnits.find((u) => u.name === "unit-0");
assert(readUnit?.loadout.consumables.length === 2, "units.loadout is a Loadout object");
assert(readUnit?.position?.x === 0 && readUnit.position.y === 0, "units.position is a Position");
assert(readUnit?.usedConsumables?.[0] === "medkit", "units.usedConsumables is string[]");
assert(readUnit?.alive === true, "units.alive comes back as a boolean, not 1");
assert(readUnit?.skin === null, "units.skin nullable");

const readTurns = await db
  .select()
  .from(turns)
  .where(eq(turns.matchId, match._id))
  .orderBy(asc(turns.turnNumber));
const readTurn = readTurns[0];
assert(readTurn?.action.kind === "consumable", "turns.action is a discriminated Action");
assert(
  readTurn?.action.kind === "consumable" && readTurn.action.slug === "medkit",
  "turns.action keeps its payload",
);
assert(readTurn?.moveTo?.x === 1, "turns.moveTo is a Position");

const teamAChat = await db
  .select()
  .from(messages)
  .where(and(eq(messages.matchId, match._id), eq(messages.team, "a")));
assert(
  teamAChat.length === 1 && teamAChat[0]?.text === "holding the left lane",
  "message round-trips",
);

const readRoster = await db.select().from(rosterUnits).where(eq(rosterUnits.userId, user._id));
assert(readRoster[0]?.loadout.weapon === "rifle", "rosterUnits.loadout is a Loadout object");

// The unique index on clerkId is what makes Stage 3's lazy user creation safe.
let duplicateRejected = false;
try {
  await db.insert(users).values({ clerkId: "user_smoke", name: "Impostor" });
} catch {
  duplicateRejected = true;
}
assert(duplicateRejected, "users.clerkId is UNIQUE");

// foreign_keys = ON, so a dangling roomId cannot be written.
let fkRejected = false;
try {
  await db.insert(players).values({
    roomId: "nope",
    userId: user._id,
    name: "ghost",
    team: "a",
    ready: false,
  });
} catch {
  fkRejected = true;
}
assert(fkRejected, "foreign keys are enforced");

// Cascade: dropping the room takes players, units and the match with it.
await db.delete(rooms).where(eq(rooms._id, room._id));
assert(
  (await db.select().from(units).where(eq(units.roomId, room._id))).length === 0,
  "units cascade",
);
assert(
  (await db.select().from(matches).where(eq(matches.roomId, room._id))).length === 0,
  "match cascades",
);
assert(
  (await db.select().from(turns).where(eq(turns.matchId, match._id))).length === 0,
  "turns cascade",
);

console.log("\nsmoke: all assertions passed");
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB_FILE}${suffix}`, { force: true });
