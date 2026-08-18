// Bridges between database rows and the pure engine types.
//
// Replaces `convex/lib/db.ts`. Two differences, both deliberate:
//
//   1. `toCatalog` / `docsToCatalog` are gone. The `items` table was dropped
//      (see the note in `shared/schema.ts`): it only ever held `CATALOG`
//      round-tripped through the database, so the catalog is now a module
//      constant built once at import time.
//   2. `toEngineUnit` / `toSnapshot` are synchronous. They were only `async` in
//      Convex because the catalog came out of the database.

import { CATALOG } from "../../shared/catalog";
import type { Catalog, EngineUnit, Snapshot } from "../../shared/engine";
import type { Match, Unit } from "../../shared/types";

/** The item catalog, keyed by slug. Immutable for the life of the process. */
export const CATALOG_MAP: Catalog = new Map(CATALOG.map((i) => [i.slug, i]));

/**
 * `position` / `hp` / `alive` / `activeCooldown` / `usedConsumables` /
 * `lastActedRound` are nullable in the schema: null means "this unit has not
 * entered a match yet". The coalescing here is the same as Convex's, and it is
 * what lets `buildPrompt` describe a lobby unit without crashing.
 */
export function toEngineUnit(row: Unit): EngineUnit {
  return {
    id: row._id,
    team: row.team,
    name: row.name,
    loadout: row.loadout,
    position: row.position ?? { x: 0, y: 0 },
    hp: row.hp ?? 0,
    alive: row.alive ?? false,
    activeCooldown: row.activeCooldown ?? 0,
    usedConsumables: row.usedConsumables ?? [],
    lastActedRound: row.lastActedRound ?? -1,
  };
}

export function toSnapshot(match: Match, units: Array<Unit>): Snapshot {
  return {
    gridSize: match.gridSize,
    walls: match.walls,
    units: units.map(toEngineUnit),
    effects: match.effects,
    roundNumber: match.roundNumber,
  };
}
