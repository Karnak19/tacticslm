// Drizzle port of `convex/schema.ts`.
//
// This lives in `shared/` rather than `server/` because table definitions are
// genuinely isomorphic: `drizzle-orm/sqlite-core` is pure builder code with no
// node or bun builtins. Only the connection is server-only, and that is
// `server/db/client.ts` (which re-exports this module, so server code has one
// import site).
//
// Two deliberate oddities, both to keep the ~1200 lines of view code compiling
// unchanged during the migration:
//
//   1. The primary key column is named `_id` and the insert timestamp
//      `_creationTime`, matching Convex's document shape. `Doc<"units">._id`
//      and `_creationTime` are threaded through MatchView/PhaserBoard/
//      SquadBuilder/Dashboard/BoardScene. Renaming them is a later commit.
//   2. Ids are `text`, not autoincrementing integers. Convex ids are opaque
//      strings, so text ids keep the UI's `string` assumptions true and make a
//      future data import from Convex a straight copy.
//
// The `items` table is intentionally absent: it was only ever `CATALOG` from
// `shared/catalog.ts` round-tripped through the database. Stage 3 builds the
// catalog `Map` from that constant directly.

import { relations } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import type { Action, Effect, Loadout, Position } from "./engine";

/** Convex `_id`: an opaque string id, generated client-side on insert. */
const id = () =>
  text("_id")
    .primaryKey()
    .$defaultFn(() => nanoid());

/** Convex `_creationTime`: epoch milliseconds, stamped on insert. */
const creationTime = () =>
  integer("_creationTime")
    .notNull()
    .$defaultFn(() => Date.now());

export const users = sqliteTable(
  "users",
  {
    _id: id(),
    _creationTime: creationTime(),
    clerkId: text("clerkId").notNull(), // Clerk identity.subject
    name: text("name").notNull(),
  },
  (t) => [
    // UNIQUE, not a plain index: Stage 3 creates users lazily on first
    // authenticated request, and two concurrent first requests can both miss
    // the SELECT and then insert. The constraint is what makes that safe.
    uniqueIndex("users_by_clerk").on(t.clerkId),
  ],
);

/** Persistent unit roster — saved builds reusable across rooms. */
export const rosterUnits = sqliteTable(
  "rosterUnits",
  {
    _id: id(),
    _creationTime: creationTime(),
    userId: text("userId")
      .notNull()
      .references(() => users._id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    personality: text("personality").notNull(),
    model: text("model").notNull(),
    /** Sprite slug; null falls back to a weapon-derived sprite. */
    skin: text("skin"),
    loadout: text("loadout", { mode: "json" }).$type<Loadout>().notNull(),
  },
  (t) => [index("rosterUnits_by_user").on(t.userId)],
);

export const rooms = sqliteTable(
  "rooms",
  {
    _id: id(),
    _creationTime: creationTime(),
    code: text("code").notNull(),
    status: text("status", { enum: ["lobby", "active", "finished"] }).notNull(),
  },
  (t) => [index("rooms_by_code").on(t.code)],
);

export const players = sqliteTable(
  "players",
  {
    _id: id(),
    _creationTime: creationTime(),
    roomId: text("roomId")
      .notNull()
      .references(() => rooms._id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => users._id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    team: text("team", { enum: ["a", "b"] }).notNull(),
    ready: integer("ready", { mode: "boolean" }).notNull(),
  },
  (t) => [index("players_by_room").on(t.roomId), index("players_by_user").on(t.userId)],
);

/**
 * Squad definition + live match state for one unit.
 *
 * `position`, `hp` and `alive` are nullable on purpose. In Convex they are
 * `v.optional()` and `toEngineUnit` coalesces (`?? 0`, `?? false`) — "hp is
 * null" is how the code tells a unit that has not entered a match yet from one
 * that is in a match. Giving these columns defaults would erase that
 * distinction, so they stay nullable.
 */
export const units = sqliteTable(
  "units",
  {
    _id: id(),
    _creationTime: creationTime(),
    roomId: text("roomId")
      .notNull()
      .references(() => rooms._id, { onDelete: "cascade" }),
    playerId: text("playerId")
      .notNull()
      .references(() => players._id, { onDelete: "cascade" }),
    team: text("team", { enum: ["a", "b"] }).notNull(),
    name: text("name").notNull(),
    personality: text("personality").notNull(),
    /** OpenRouter model id, chosen per unit. */
    model: text("model").notNull(),
    skin: text("skin"),
    loadout: text("loadout", { mode: "json" }).$type<Loadout>().notNull(),
    // --- Match state (set when the match starts) ---
    position: text("position", { mode: "json" }).$type<Position>(),
    hp: integer("hp"),
    alive: integer("alive", { mode: "boolean" }),
    /** Rounds until the active is usable; 0 = ready. */
    activeCooldown: integer("activeCooldown"),
    usedConsumables: text("usedConsumables", { mode: "json" }).$type<Array<string>>(),
    /** For the dagger's timing bonus. */
    lastActedRound: integer("lastActedRound"),
  },
  (t) => [index("units_by_room").on(t.roomId), index("units_by_player").on(t.playerId)],
);

/**
 * `effects` and `initiative` hold unit ids *inside* JSON, so there is no
 * foreign key and no cascade on them — a deleted unit can leave a dangling id
 * behind. This is not an oversight: Convex had exactly the same weakness, and
 * `nextTurn` plus the effect filtering already skip ids they cannot resolve.
 * Normalising them into join tables would mean rewriting the pure engine.
 *
 * `currentUnitId` is FK-less for the same reason: it points at a unit that the
 * initiative array also names, so a cascade or set-null on it would only half-fix
 * a state the engine already handles.
 */
export const matches = sqliteTable(
  "matches",
  {
    _id: id(),
    _creationTime: creationTime(),
    roomId: text("roomId")
      .notNull()
      .references(() => rooms._id, { onDelete: "cascade" }),
    status: text("status", { enum: ["running", "finished"] }).notNull(),
    walls: text("walls", { mode: "json" }).$type<Array<Position>>().notNull(),
    gridSize: integer("gridSize").notNull(),
    turnNumber: integer("turnNumber").notNull(),
    /** A round is one full pass through the initiative order. */
    roundNumber: integer("roundNumber").notNull(),
    /** Cap in rounds. */
    turnCap: integer("turnCap").notNull(),
    /** Initiative order, fixed at match start (speed desc); dead units skipped. */
    initiative: text("initiative", { mode: "json" }).$type<Array<string>>().notNull(),
    initiativeIndex: integer("initiativeIndex").notNull(),
    currentUnitId: text("currentUnitId"),
    effects: text("effects", { mode: "json" }).$type<Array<Effect>>().notNull(),
    winnerTeam: text("winnerTeam", { enum: ["a", "b", "draw"] }),
  },
  (t) => [index("matches_by_room").on(t.roomId)],
);

/** One row per unit turn — the replay is this table. */
export const turns = sqliteTable(
  "turns",
  {
    _id: id(),
    _creationTime: creationTime(),
    matchId: text("matchId")
      .notNull()
      .references(() => matches._id, { onDelete: "cascade" }),
    turnNumber: integer("turnNumber").notNull(),
    unitId: text("unitId")
      .notNull()
      .references(() => units._id, { onDelete: "cascade" }),
    moveTo: text("moveTo", { mode: "json" }).$type<Position>(),
    action: text("action", { mode: "json" }).$type<Action>().notNull(),
    /** Engine-computed result, for replay rendering without re-simulation. */
    summary: text("summary").notNull(),
    /** The LLM's brief reasoning — shown in the replay. */
    thinking: text("thinking"),
  },
  (t) => [index("turns_by_match").on(t.matchId, t.turnNumber)],
);

/**
 * Team chat: spoken on a unit's turn, served only to its own team while the
 * match runs; revealed to everyone in the replay.
 */
export const messages = sqliteTable(
  "messages",
  {
    _id: id(),
    _creationTime: creationTime(),
    matchId: text("matchId")
      .notNull()
      .references(() => matches._id, { onDelete: "cascade" }),
    unitId: text("unitId")
      .notNull()
      .references(() => units._id, { onDelete: "cascade" }),
    team: text("team", { enum: ["a", "b"] }).notNull(),
    turnNumber: integer("turnNumber").notNull(),
    text: text("text").notNull(),
  },
  (t) => [index("messages_by_match_and_team").on(t.matchId, t.team)],
);

// --- Relations, for `db.query.*.with({...})` in Stage 3 ---

export const usersRelations = relations(users, ({ many }) => ({
  rosterUnits: many(rosterUnits),
  players: many(players),
}));

export const roomsRelations = relations(rooms, ({ many }) => ({
  players: many(players),
  units: many(units),
  matches: many(matches),
}));

export const playersRelations = relations(players, ({ one, many }) => ({
  room: one(rooms, { fields: [players.roomId], references: [rooms._id] }),
  user: one(users, { fields: [players.userId], references: [users._id] }),
  units: many(units),
}));

export const unitsRelations = relations(units, ({ one }) => ({
  room: one(rooms, { fields: [units.roomId], references: [rooms._id] }),
  player: one(players, { fields: [units.playerId], references: [players._id] }),
}));

export const matchesRelations = relations(matches, ({ one, many }) => ({
  room: one(rooms, { fields: [matches.roomId], references: [rooms._id] }),
  turns: many(turns),
  messages: many(messages),
}));

export const turnsRelations = relations(turns, ({ one }) => ({
  match: one(matches, { fields: [turns.matchId], references: [matches._id] }),
  unit: one(units, { fields: [turns.unitId], references: [units._id] }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  match: one(matches, { fields: [messages.matchId], references: [matches._id] }),
  unit: one(units, { fields: [messages.unitId], references: [units._id] }),
}));
