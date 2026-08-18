#!/usr/bin/env bash
# Restores public/sprites/craftpix/ from the CraftPix zips.
#
# The art is licensed for use but not for redistribution, and this repo is
# public, so the files themselves are gitignored. A fresh clone runs this once.
#
#   bash scripts/setup-assets.sh [zip-dir]     # zip-dir defaults to ~/Downloads
set -euo pipefail

ZIP_DIR="${1:-$HOME/Downloads}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/public/sprites/craftpix"

DUNGEON="craftpix-net-169442-free-2d-top-down-pixel-dungeon-asset-pack"
SWORDSMAN="craftpix-net-180537-free-swordsman-1-3-level-pixel-top-down-sprite-character"

missing=()
for pack in "$DUNGEON" "$SWORDSMAN"; do
  [[ -f "$ZIP_DIR/$pack.zip" ]] || missing+=("$pack.zip")
done

if [[ ${#missing[@]} -gt 0 ]]; then
  cat >&2 <<MSG
Missing zip(s) in $ZIP_DIR:
$(printf '  - %s\n' "${missing[@]}")

CraftPix downloads need a free account. Sign in at https://craftpix.net, grab the
packs below, leave the zips named as downloaded in $ZIP_DIR, then re-run this script.

  2D Top-Down Pixel Dungeon (terrain, used)
    https://craftpix.net/freebies/free-2d-top-down-pixel-dungeon-asset-pack/
  Swordsman 1-3 Level (characters, used)
    https://craftpix.net/freebies/free-swordsman-1-3-level-pixel-top-down-sprite-character-pack/
  Base 4-Direction Male Character (evaluated, not used)
    https://craftpix.net/freebies/free-base-4-direction-male-character-pixel-art/
  Undead Tileset Top-Down (evaluated, not used)
    https://craftpix.net/freebies/free-undead-tileset-top-down-pixel-art/
  Top-Down Hunt Animals (evaluated, not used)
    https://craftpix.net/freebies/free-top-down-hunt-animals-pixel-sprite-pack/
MSG
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

unzip -qo "$ZIP_DIR/$DUNGEON.zip" -d "$TMP/dungeon"
unzip -qo "$ZIP_DIR/$SWORDSMAN.zip" -d "$TMP/swordsman"

# The zips may or may not carry a top-level folder; find the real asset roots.
find_dir() { find "$1" -type d -name "$2" -print -quit; }
DUN_TILED="$(find_dir "$TMP/dungeon" Tiled_files)"
SW_PNG="$(find_dir "$TMP/swordsman" PNG)"

mkdir -p "$OUT/terrain" "$OUT/swordsman"

# Terrain: the Tiled_files copy of walls_floor is the 17-column sheet the pack's
# own Dungeon1.tmx indexes against, so tile numbers match the pack's metadata.
cp "$DUN_TILED/walls_floor.png" "$OUT/terrain/walls_floor.png"

# Characters: the with-shadow composites, four animations per tier.
for lvl in 1 2 3; do
  for anim in Idle Walk attack Death; do
    cp "$SW_PNG/Swordsman_lvl$lvl/With_shadow/Swordsman_lvl${lvl}_${anim}_with_shadow.png" \
      "$OUT/swordsman/lvl${lvl}_${anim}.png"
  done
done

echo "Restored CraftPix art into public/sprites/craftpix/"
