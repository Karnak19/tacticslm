import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const slotValidator = v.union(
  v.literal("weapon"),
  v.literal("helmet"),
  v.literal("chest"),
  v.literal("boots"),
  v.literal("active"),
  v.literal("consumable"),
);

export const loadoutValidator = v.object({
  weapon: v.string(),
  helmet: v.string(),
  chest: v.string(),
  boots: v.string(),
  active: v.string(),
  consumables: v.array(v.string()),
});

export const positionValidator = v.object({ x: v.number(), y: v.number() });

// Timed board effects (smoke clouds, taunts, buffs). `expiresAfterRound` is the
// last round the effect is active.
export const effectValidator = v.union(
  v.object({
    kind: v.literal("smoke"),
    cells: v.array(positionValidator),
    expiresAfterRound: v.number(),
  }),
  v.object({
    kind: v.literal("taunt"),
    sourceUnitId: v.id("units"),
    affectedUnitIds: v.array(v.id("units")),
    expiresAfterRound: v.number(),
  }),
  v.object({
    kind: v.literal("adrenaline"),
    unitId: v.id("units"),
    expiresAfterRound: v.number(),
  }),
  // Cloak's first-hit reduction already consumed this round.
  v.object({
    kind: v.literal("cloak_spent"),
    unitId: v.id("units"),
    expiresAfterRound: v.number(),
  }),
);

export const actionValidator = v.union(
  v.object({
    kind: v.literal("attack"),
    targetUnitId: v.id("units"),
  }),
  v.object({
    kind: v.literal("active"),
    // target cell for area effects (smoke, grenade), unit for heal/taunt
    targetCell: v.optional(positionValidator),
    targetUnitId: v.optional(v.id("units")),
  }),
  v.object({
    kind: v.literal("consumable"),
    slug: v.string(),
    targetCell: v.optional(positionValidator),
    targetUnitId: v.optional(v.id("units")),
  }),
  v.object({ kind: v.literal("wait") }),
);

export default defineSchema(
  {
    // Item catalog — numeric stats live here (balance is data);
    // special behaviors live in engine code keyed by slug.
    items: defineTable({
      slug: v.string(),
      slot: slotValidator,
      name: v.string(),
      description: v.string(),
      stats: v.object({
        hpBonus: v.optional(v.number()),
        moveBonus: v.optional(v.number()),
        speedBonus: v.optional(v.number()),
        damage: v.optional(v.number()),
        range: v.optional(v.number()),
        cooldown: v.optional(v.number()),
        heal: v.optional(v.number()),
        area: v.optional(v.number()), // square side length (3 = 3×3)
        duration: v.optional(v.number()), // rounds
      }),
      flags: v.object({
        needsLos: v.optional(v.boolean()),
        friendlyFire: v.optional(v.boolean()),
        crossesWalls: v.optional(v.boolean()),
      }),
    })
      .index("by_slug", ["slug"])
      .index("by_slot", ["slot"]),

    users: defineTable({
      clerkId: v.string(), // Clerk identity.subject
      name: v.string(),
    }).index("by_clerk", ["clerkId"]),

    // Persistent unit roster — saved builds reusable across rooms.
    rosterUnits: defineTable({
      userId: v.id("users"),
      name: v.string(),
      personality: v.string(),
      model: v.string(),
      skin: v.optional(v.string()), // sprite slug; falls back to weapon-derived
      loadout: loadoutValidator,
    }).index("by_user", ["userId"]),

    rooms: defineTable({
      code: v.string(),
      status: v.union(v.literal("lobby"), v.literal("active"), v.literal("finished")),
    }).index("by_code", ["code"]),

    players: defineTable({
      roomId: v.id("rooms"),
      userId: v.id("users"),
      name: v.string(),
      team: v.union(v.literal("a"), v.literal("b")),
      ready: v.boolean(),
    })
      .index("by_room", ["roomId"])
      .index("by_user", ["userId"]),

    // Squad definition + live match state for one unit.
    units: defineTable({
      roomId: v.id("rooms"),
      playerId: v.id("players"),
      team: v.union(v.literal("a"), v.literal("b")),
      name: v.string(),
      personality: v.string(),
      model: v.string(), // OpenRouter model id, chosen per unit
      skin: v.optional(v.string()),
      loadout: loadoutValidator,
      // Match state (set when the match starts)
      position: v.optional(positionValidator),
      hp: v.optional(v.number()),
      alive: v.optional(v.boolean()),
      activeCooldown: v.optional(v.number()), // rounds until usable, 0 = ready
      usedConsumables: v.optional(v.array(v.string())),
      lastActedRound: v.optional(v.number()), // for dagger's timing bonus
    })
      .index("by_room", ["roomId"])
      .index("by_player", ["playerId"]),

    matches: defineTable({
      roomId: v.id("rooms"),
      status: v.union(v.literal("running"), v.literal("finished")),
      walls: v.array(positionValidator),
      gridSize: v.number(),
      turnNumber: v.number(),
      // A round is one full pass through the initiative order.
      roundNumber: v.number(),
      turnCap: v.number(), // cap in rounds
      // Initiative order, fixed at match start (speed desc), dead units skipped.
      initiative: v.array(v.id("units")),
      initiativeIndex: v.number(),
      currentUnitId: v.optional(v.id("units")),
      effects: v.array(effectValidator),
      winnerTeam: v.optional(v.union(v.literal("a"), v.literal("b"), v.literal("draw"))),
    }).index("by_room", ["roomId"]),

    // One row per unit turn — the replay is this table.
    turns: defineTable({
      matchId: v.id("matches"),
      turnNumber: v.number(),
      unitId: v.id("units"),
      moveTo: v.optional(positionValidator),
      action: actionValidator,
      // Engine-computed results, for replay rendering without re-simulation.
      summary: v.string(),
      // The LLM's brief reasoning — shown in the replay.
      thinking: v.optional(v.string()),
    }).index("by_match", ["matchId", "turnNumber"]),

    // Team chat: spoken on a unit's turn, served only to its own team
    // while the match runs; revealed to everyone in the replay.
    messages: defineTable({
      matchId: v.id("matches"),
      unitId: v.id("units"),
      team: v.union(v.literal("a"), v.literal("b")),
      turnNumber: v.number(),
      text: v.string(),
    }).index("by_match_and_team", ["matchId", "team"]),
  },
  { schemaValidation: true },
);
