// Bridges between Convex documents and the pure engine types.

import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { CatalogItem, Slot } from "./catalog";
import type { Catalog, EngineUnit, Snapshot, Team } from "./engine";

export function docsToCatalog(items: Array<Doc<"items">>): Catalog {
  return new Map(
    items.map((i) => [
      i.slug,
      {
        slug: i.slug,
        slot: i.slot as Slot,
        name: i.name,
        description: i.description,
        stats: i.stats,
        flags: i.flags,
      } satisfies CatalogItem,
    ]),
  );
}

export async function toCatalog(ctx: QueryCtx): Promise<Catalog> {
  return docsToCatalog(await ctx.db.query("items").collect());
}

export function toEngineUnit(doc: Doc<"units">): EngineUnit {
  return {
    id: doc._id,
    team: doc.team as Team,
    name: doc.name,
    loadout: doc.loadout,
    position: doc.position ?? { x: 0, y: 0 },
    hp: doc.hp ?? 0,
    alive: doc.alive ?? false,
    activeCooldown: doc.activeCooldown ?? 0,
    usedConsumables: doc.usedConsumables ?? [],
    lastActedRound: doc.lastActedRound ?? -1,
  };
}

export function toSnapshot(match: Doc<"matches">, units: Array<Doc<"units">>): Snapshot {
  return {
    gridSize: match.gridSize,
    walls: match.walls,
    units: units.map(toEngineUnit),
    effects: match.effects,
    roundNumber: match.roundNumber,
  };
}
