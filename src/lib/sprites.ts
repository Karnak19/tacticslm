// Kenney Tiny Dungeon (CC0) sprites — see public/sprites.

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

export function skinSprite(skin: string | undefined, weapon: string): string {
  const slug = skin ?? WEAPON_SKINS[weapon] ?? "squire";
  return SKINS.find((s) => s.slug === slug)?.src ?? SKINS[0].src;
}

// Deterministic floor variant so the board doesn't change between renders.
export function floorTile(x: number, y: number): string {
  const h = (x * 31 + y * 17) % 23;
  return h === 0 ? FLOOR_TILES[1] : FLOOR_TILES[0];
}

export function itemIcon(slug: string): string {
  return `/icons/${slug}.svg`;
}
