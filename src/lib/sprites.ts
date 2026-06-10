// Kenney Tiny Dungeon (CC0) sprites — see public/sprites.
// Unit sprite is picked by weapon: the build defines the look.

export const FLOOR_TILES = [
  "/sprites/tile_0000.png",
  "/sprites/tile_0012.png",
  "/sprites/tile_0024.png",
];
export const WALL_TILE = "/sprites/tile_0057.png";

const WEAPON_SPRITES: Record<string, string> = {
  sword: "/sprites/tile_0096.png", // knight
  spear: "/sprites/tile_0097.png", // soldier
  bow: "/sprites/tile_0112.png", // ranger
  crossbow: "/sprites/tile_0087.png", // helmed veteran
  dagger: "/sprites/tile_0109.png", // brute
};

export function unitSprite(weapon: string): string {
  return WEAPON_SPRITES[weapon] ?? "/sprites/tile_0085.png";
}

// Deterministic floor variant so the board doesn't change between renders.
export function floorTile(x: number, y: number): string {
  const h = (x * 31 + y * 17) % 23;
  return h === 0 ? FLOOR_TILES[1] : FLOOR_TILES[0];
}

export function itemIcon(slug: string): string {
  return `/icons/${slug}.svg`;
}
