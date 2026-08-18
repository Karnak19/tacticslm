// Two art sets live here, on purpose.
//
// The DOM views (roster, squad builder, landing page) want one still image per
// unit or tile, addressed by URL: that stays Kenney Tiny Dungeon (CC0, committed).
//
// The Phaser board wants spritesheets it can slice and animate: that's CraftPix,
// restored by `scripts/setup-assets.sh` and gitignored. Its exports are the
// TERRAIN / CHARACTERS block at the bottom.

// -- Kenney Tiny Dungeon (CC0) — see public/sprites. -------------------------

export const FLOOR_TILES = [
  "/sprites/tile_0000.png",
  "/sprites/tile_0012.png",
  "/sprites/tile_0024.png",
];
export const WALL_TILE = "/sprites/tile_0057.png";

// Selectable unit skins. `slug` is stored on the unit.
export const SKINS: Array<{ slug: string; name: string; src: string }> = [
  { slug: "knight", name: "Knight", src: "/sprites/tile_0096.png" },
  { slug: "soldier", name: "Soldier", src: "/sprites/tile_0097.png" },
  { slug: "ranger", name: "Ranger", src: "/sprites/tile_0112.png" },
  { slug: "veteran", name: "Veteran", src: "/sprites/tile_0087.png" },
  { slug: "brute", name: "Brute", src: "/sprites/tile_0109.png" },
  { slug: "mage", name: "Mage", src: "/sprites/tile_0084.png" },
  { slug: "squire", name: "Squire", src: "/sprites/tile_0085.png" },
  { slug: "monk", name: "Monk", src: "/sprites/tile_0086.png" },
  { slug: "noble", name: "Noble", src: "/sprites/tile_0088.png" },
  { slug: "peasant", name: "Peasant", src: "/sprites/tile_0098.png" },
  { slug: "princess", name: "Princess", src: "/sprites/tile_0099.png" },
  { slug: "elder", name: "Elder", src: "/sprites/tile_0100.png" },
  { slug: "ghost", name: "Ghost", src: "/sprites/tile_0108.png" },
  { slug: "imp", name: "Imp", src: "/sprites/tile_0110.png" },
  { slug: "gnome", name: "Gnome", src: "/sprites/tile_0111.png" },
  { slug: "bat", name: "Bat", src: "/sprites/tile_0120.png" },
  { slug: "wisp", name: "Wisp", src: "/sprites/tile_0121.png" },
  { slug: "spider", name: "Spider", src: "/sprites/tile_0122.png" },
  { slug: "rat", name: "Rat", src: "/sprites/tile_0123.png" },
  { slug: "slime", name: "Slime", src: "/sprites/tile_0124.png" },
];

// Fallback for units without a chosen skin: derive from weapon.
const WEAPON_SKINS: Record<string, string> = {
  sword: "knight",
  spear: "soldier",
  bow: "ranger",
  crossbow: "veteran",
  dagger: "brute",
};

function resolveSkinSlug(skin: string | undefined, weapon: string): string {
  return skin ?? WEAPON_SKINS[weapon] ?? "squire";
}

export function skinSprite(skin: string | undefined, weapon: string): string {
  const slug = resolveSkinSlug(skin, weapon);
  return SKINS.find((s) => s.slug === slug)?.src ?? SKINS[0].src;
}

// Deterministic floor variant so the board doesn't change between renders.
// FLOOR_TILES[0] is a plain slab; [1] is pebbles and [2] is rubble, scattered
// thinly enough to break up the floor without reading as clutter.
export function floorTile(x: number, y: number): string {
  // A plain `x * a + y * b` stays linear, which lines the decorated cells up
  // into stripes; the bit mixing scatters them instead.
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  const pick = h % 13;
  if (pick === 0) return FLOOR_TILES[1];
  if (pick === 7) return FLOOR_TILES[2];
  return FLOOR_TILES[0];
}

export function itemIcon(slug: string): string {
  return `/icons/${slug}.svg`;
}

// -- CraftPix (board renderer only) ------------------------------------------
// Restored by `scripts/setup-assets.sh`; see public/sprites/craftpix/README.md.

/** The dungeon terrain sheet. 17 columns of 16x16, frame index = row * 17 + col. */
export const TERRAIN_SHEET = {
  key: "craftpix-terrain",
  url: "/sprites/craftpix/terrain/walls_floor.png",
  tile: 16,
} as const;

/** A full-cell cobble block, so a wall reads as one solid stone per cell. */
export const WALL_FRAME = 30;

/**
 * [0] is the sparse flagstone the floor is mostly made of; [1] and [2] have
 * denser seams and get scattered thinly over it.
 */
const FLOOR_FRAMES = [246, 245, 229] as const;

/** How thinly the two decorated flagstones get sprinkled over the plain one. */
const FLOOR_SCATTER = 5;

/**
 * Deterministic floor variant, same mixing as `floorTile` so the board doesn't
 * change between renders. A plain `x * a + y * b` stays linear, which lines the
 * decorated cells up into stripes; the bit mixing scatters them instead.
 */
export function floorFrame(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  const pick = h % FLOOR_SCATTER;
  if (pick === 0) return FLOOR_FRAMES[1];
  if (pick === 1) return FLOOR_FRAMES[2];
  return FLOOR_FRAMES[0];
}

/** Row order in every character sheet, confirmed by eye against the frames. */
export const FACINGS = ["down", "left", "right", "up"] as const;
export type Facing = (typeof FACINGS)[number];

export type CharacterAnim = "idle" | "walk" | "attack" | "death";

/** 64x64 frames, four rows of facings, N frames per row. */
export const CHARACTER_FRAME = 64;

const ANIM_FILES: Record<CharacterAnim, { file: string; frames: number; fps: number }> = {
  idle: { file: "Idle", frames: 12, fps: 10 },
  walk: { file: "Walk", frames: 6, fps: 10 },
  attack: { file: "attack", frames: 8, fps: 16 },
  death: { file: "Death", frames: 7, fps: 10 },
};

export const CHARACTER_ANIMS = Object.keys(ANIM_FILES) as Array<CharacterAnim>;

/** Only three sprites exist so far — see skinTier. */
export const CHARACTER_TIERS = [1, 2, 3] as const;
export type CharacterTier = (typeof CHARACTER_TIERS)[number];

/**
 * Row length is the sheet's width for every animation but one: the up-facing
 * idle is a four-frame loop the artist left padded with blank cells, so reading
 * the full twelve renders nothing for two thirds of the loop. Measured off the
 * sheets, not assumed.
 */
const SHORT_ROWS: Partial<Record<`${CharacterAnim}-${Facing}`, number>> = {
  "idle-up": 4,
};

export function characterSheet(tier: CharacterTier, anim: CharacterAnim) {
  const { file, frames, fps } = ANIM_FILES[anim];
  return {
    key: `craftpix-sw${tier}-${anim}`,
    url: `/sprites/craftpix/swordsman/lvl${tier}_${file}.png`,
    /** Frames per sheet row — the stride between facings. */
    frames,
    /** How many of a facing's frames are actually drawn. */
    framesFor: (facing: Facing) => SHORT_ROWS[`${anim}-${facing}`] ?? frames,
    fps,
  };
}

/**
 * ~20 skins, 3 character sprites. Spread the skins evenly over the tiers so the
 * choice still shows up as *something* on the board; team colour is what
 * actually tells the sides apart. Units will look repetitive until the skins get
 * their own recolours.
 */
export function skinTier(skin: string | undefined, weapon: string): CharacterTier {
  const slug = resolveSkinSlug(skin, weapon);
  const index = SKINS.findIndex((s) => s.slug === slug);
  return CHARACTER_TIERS[(index < 0 ? 0 : index) % CHARACTER_TIERS.length];
}
