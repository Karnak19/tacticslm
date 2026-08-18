// Row types inferred from the Drizzle schema, re-exported here so the UI can
// import them from `shared/` instead of `convex/_generated/dataModel`.
//
// The migration of the view layer is a find-replace: `Doc<"units">` becomes
// `Unit`, `Doc<"matches">` becomes `Match`, and so on (see the table below).
// Because the schema keeps Convex's `_id` / `_creationTime` column names, every
// existing field access keeps compiling.
//
//   Doc<"users">       -> User
//   Doc<"rosterUnits"> -> RosterUnit
//   Doc<"rooms">       -> Room
//   Doc<"players">     -> Player
//   Doc<"units">       -> Unit
//   Doc<"matches">     -> Match
//   Doc<"turns">       -> Turn
//   Doc<"messages">    -> Message
//   Id<"units">        -> string   (ids are opaque strings, as in Convex)
//
// `Doc<"items">` has no counterpart: the items table is gone and the catalog is
// the `CATALOG` constant in `shared/catalog.ts`.

import type { matches, messages, players, rooms, rosterUnits, turns, units, users } from "./schema";

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type RosterUnit = typeof rosterUnits.$inferSelect;
export type NewRosterUnit = typeof rosterUnits.$inferInsert;

export type Room = typeof rooms.$inferSelect;
export type NewRoom = typeof rooms.$inferInsert;

export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;

export type Unit = typeof units.$inferSelect;
export type NewUnit = typeof units.$inferInsert;

export type Match = typeof matches.$inferSelect;
export type NewMatch = typeof matches.$inferInsert;

export type Turn = typeof turns.$inferSelect;
export type NewTurn = typeof turns.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

/** Convex ids were opaque strings; nothing in the UI relies on more than that. */
export type Id = string;
