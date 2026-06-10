// v1 item catalog — seeded into the `items` table (idempotent, keyed by slug).
// Numeric stats are data; special behaviors are implemented in the engine
// keyed by slug (e.g. dagger's timing bonus, taunt targeting, circlet comms).

export type Slot = "weapon" | "helmet" | "chest" | "boots" | "active" | "consumable";

export type CatalogItem = {
  slug: string;
  slot: Slot;
  name: string;
  description: string;
  stats: {
    hpBonus?: number;
    moveBonus?: number;
    speedBonus?: number;
    damage?: number;
    range?: number;
    cooldown?: number;
    heal?: number;
    area?: number;
    duration?: number;
  };
  flags: {
    needsLos?: boolean;
    friendlyFire?: boolean;
    crossesWalls?: boolean;
    thorns?: boolean;
  };
};

export const CATALOG: Array<CatalogItem> = [
  // Weapons
  {
    slug: "sword",
    slot: "weapon",
    name: "Sword",
    description: "Range 1, 6 damage. Grants +1 move.",
    stats: { damage: 6, range: 1, moveBonus: 1 },
    flags: {},
  },
  {
    slug: "spear",
    slot: "weapon",
    name: "Spear",
    description: "Range 2, 5 damage. Can hit over an adjacent unit.",
    stats: { damage: 5, range: 2 },
    flags: {},
  },
  {
    slug: "bow",
    slot: "weapon",
    name: "Bow",
    description: "Range 5, 4 damage. Requires line of sight.",
    stats: { damage: 4, range: 5 },
    flags: { needsLos: true },
  },
  {
    slug: "crossbow",
    slot: "weapon",
    name: "Crossbow",
    description: "Range 6, 6 damage. Requires line of sight. Heavy: −3 speed.",
    stats: { damage: 6, range: 6, speedBonus: -3 },
    flags: { needsLos: true },
  },
  {
    slug: "dagger",
    slot: "weapon",
    name: "Dagger",
    description:
      "Range 1, 4 damage. +4 speed. Deals +2 damage if the target already acted this round.",
    stats: { damage: 4, range: 1, speedBonus: 4 },
    flags: {},
  },
  {
    slug: "greatsword",
    slot: "weapon",
    name: "Greatsword",
    description: "Range 1, 8 damage. Heavy: −2 speed, −1 move.",
    stats: { damage: 8, range: 1, speedBonus: -2, moveBonus: -1 },
    flags: {},
  },
  {
    slug: "rapier",
    slot: "weapon",
    name: "Rapier",
    description: "Range 1, 5 damage. Elegant: +2 speed.",
    stats: { damage: 5, range: 1, speedBonus: 2 },
    flags: {},
  },
  {
    slug: "halberd",
    slot: "weapon",
    name: "Halberd",
    description: "Range 2, 6 damage. Unwieldy: −2 speed.",
    stats: { damage: 6, range: 2, speedBonus: -2 },
    flags: {},
  },
  {
    slug: "sling",
    slot: "weapon",
    name: "Sling",
    description: "Range 4, 3 damage. Lobbed: no line of sight needed.",
    stats: { damage: 3, range: 4 },
    flags: {},
  },
  // Helmets
  {
    slug: "great_helm",
    slot: "helmet",
    name: "Great Helm",
    description: "+3 HP, −1 speed.",
    stats: { hpBonus: 3, speedBonus: -1 },
    flags: {},
  },
  {
    slug: "hood",
    slot: "helmet",
    name: "Hood",
    description: "+3 speed.",
    stats: { speedBonus: 3 },
    flags: {},
  },
  {
    slug: "visor",
    slot: "helmet",
    name: "Visor",
    description: "+1 attack range (ranged weapons only).",
    stats: { range: 1 },
    flags: {},
  },
  {
    slug: "strategists_circlet",
    slot: "helmet",
    name: "Strategist's Circlet",
    description: "Your messages to teammates can be twice as long.",
    stats: {},
    flags: {},
  },
  {
    slug: "bascinet",
    slot: "helmet",
    name: "Bascinet",
    description: "+2 HP, +1 speed.",
    stats: { hpBonus: 2, speedBonus: 1 },
    flags: {},
  },
  {
    slug: "berserker_mask",
    slot: "helmet",
    name: "Berserker Mask",
    description: "+2 damage, −2 HP. Rage has a price.",
    stats: { damage: 2, hpBonus: -2 },
    flags: {},
  },
  // Chest
  {
    slug: "plate",
    slot: "chest",
    name: "Plate Armor",
    description: "+8 HP, −1 move, −2 speed.",
    stats: { hpBonus: 8, moveBonus: -1, speedBonus: -2 },
    flags: {},
  },
  {
    slug: "chainmail",
    slot: "chest",
    name: "Chainmail",
    description: "+5 HP, −1 speed.",
    stats: { hpBonus: 5, speedBonus: -1 },
    flags: {},
  },
  {
    slug: "leather",
    slot: "chest",
    name: "Leather Armor",
    description: "+3 HP.",
    stats: { hpBonus: 3 },
    flags: {},
  },
  {
    slug: "cloak",
    slot: "chest",
    name: "Cloak",
    description:
      "+1 move. The first attack against you each round deals −1 damage while you are not adjacent to an enemy.",
    stats: { moveBonus: 1 },
    flags: {},
  },
  {
    slug: "brigandine",
    slot: "chest",
    name: "Brigandine",
    description: "+6 HP, −1 move.",
    stats: { hpBonus: 6, moveBonus: -1 },
    flags: {},
  },
  {
    slug: "spiked_armor",
    slot: "chest",
    name: "Spiked Armor",
    description: "+4 HP. Melee attackers take 1 damage.",
    stats: { hpBonus: 4 },
    flags: { thorns: true },
  },
  // Boots
  {
    slug: "greaves",
    slot: "boots",
    name: "Greaves",
    description: "+2 HP, −1 speed.",
    stats: { hpBonus: 2, speedBonus: -1 },
    flags: {},
  },
  {
    slug: "swiftboots",
    slot: "boots",
    name: "Swiftboots",
    description: "+1 move.",
    stats: { moveBonus: 1 },
    flags: {},
  },
  {
    slug: "skirmishers_boots",
    slot: "boots",
    name: "Skirmisher's Boots",
    description: "+3 speed.",
    stats: { speedBonus: 3 },
    flags: {},
  },
  {
    slug: "climbing_hooks",
    slot: "boots",
    name: "Climbing Hooks",
    description: "May cross 1 wall cell per move.",
    stats: {},
    flags: { crossesWalls: true },
  },
  {
    slug: "heavy_sabatons",
    slot: "boots",
    name: "Heavy Sabatons",
    description: "+3 HP, −1 move.",
    stats: { hpBonus: 3, moveBonus: -1 },
    flags: {},
  },
  {
    slug: "scout_boots",
    slot: "boots",
    name: "Scout Boots",
    description: "+1 move, +1 speed.",
    stats: { moveBonus: 1, speedBonus: 1 },
    flags: {},
  },
  // Actives (used instead of attacking; per-item cooldowns)
  {
    slug: "heal_pulse",
    slot: "active",
    name: "Heal Pulse",
    description: "Restore 6 HP to a teammate within range 3, or yourself. Cooldown 3.",
    stats: { heal: 6, range: 3, cooldown: 3 },
    flags: {},
  },
  {
    slug: "smoke_bomb",
    slot: "active",
    name: "Smoke Bomb",
    description: "A 3×3 area blocks line of sight for 1 round. Cooldown 4.",
    stats: { range: 4, area: 3, duration: 1, cooldown: 4 },
    flags: {},
  },
  {
    slug: "dash",
    slot: "active",
    name: "Dash",
    description: "+3 move this turn, stacks with normal movement. Cooldown 2.",
    stats: { moveBonus: 3, cooldown: 2 },
    flags: {},
  },
  {
    slug: "taunt",
    slot: "active",
    name: "Taunt",
    description: "Enemies within range 4 must target you next turn if they attack. Cooldown 3.",
    stats: { range: 4, duration: 1, cooldown: 3 },
    flags: {},
  },
  {
    slug: "grenade",
    slot: "active",
    name: "Grenade",
    description: "Range 4: deal 3 damage in a 3×3 area. Hits allies too. Cooldown 4.",
    stats: { damage: 3, range: 4, area: 3, cooldown: 4 },
    flags: { friendlyFire: true },
  },
  {
    slug: "shield_wall",
    slot: "active",
    name: "Shield Wall",
    description: "Take −2 damage from every hit this round and the next. Cooldown 3.",
    stats: { duration: 1, cooldown: 3 },
    flags: {},
  },
  {
    slug: "blink",
    slot: "active",
    name: "Blink",
    description: "Teleport to a free cell within range 3, through walls. Cooldown 4.",
    stats: { range: 3, cooldown: 4 },
    flags: {},
  },
  // Consumables (single-use; consuming is the turn's action)
  {
    slug: "health_potion",
    slot: "consumable",
    name: "Health Potion",
    description: "Restore 8 HP to yourself.",
    stats: { heal: 8 },
    flags: {},
  },
  {
    slug: "adrenaline",
    slot: "consumable",
    name: "Adrenaline",
    description: "+2 move and +4 speed for 2 rounds.",
    stats: { moveBonus: 2, speedBonus: 4, duration: 2 },
    flags: {},
  },
  {
    slug: "throwing_knife",
    slot: "consumable",
    name: "Throwing Knife",
    description: "Range 3, 3 damage. Lobbed: no line of sight needed.",
    stats: { damage: 3, range: 3 },
    flags: {},
  },
  {
    slug: "smoke_vial",
    slot: "consumable",
    name: "Smoke Vial",
    description: "Range 3: a 3×3 area blocks line of sight for 1 round.",
    stats: { range: 3, area: 3, duration: 1 },
    flags: {},
  },
  {
    slug: "bomb",
    slot: "consumable",
    name: "Bomb",
    description: "Range 3: deal 2 damage in a 3×3 area. Hits allies too.",
    stats: { damage: 2, range: 3, area: 3 },
    flags: { friendlyFire: true },
  },
  {
    slug: "antidote",
    slot: "consumable",
    name: "Antidote",
    description: "Removes all debuffs from yourself.",
    stats: {},
    flags: {},
  },
];

// Base statline before items. No innate attack — the weapon is the only attack source.
export const BASE_STATS = { hp: 20, move: 3, speed: 10 } as const;
export const GRID_SIZE = 16;
export const TURN_CAP = 20;
export const CONSUMABLE_SLOTS = 2;
