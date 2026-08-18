# CraftPix art (not committed)

The Phaser board renders terrain and characters from CraftPix pixel art. CraftPix
licenses these freebies for use in games but forbids redistributing the files, and
this repo is public — so everything in this directory except this README is
gitignored.

Restore it with:

```sh
bash scripts/setup-assets.sh          # reads the zips from ~/Downloads
bash scripts/setup-assets.sh /path/to/zips
```

The script tells you which packs to download, and from where, if the zips aren't
there. Downloads need a free CraftPix account.

## What lands here

| Path | Source | Grid |
| --- | --- | --- |
| `terrain/walls_floor.png` | 2D Top-Down Pixel Dungeon, `Tiled_files/walls_floor.png` | 16x16 tiles, 17 columns, 493 tiles |
| `swordsman/lvl{1,2,3}_{Idle,Walk,attack,Death}.png` | Swordsman 1-3 Level, `With_shadow` composites | 64x64 frames, 4 rows = down, left, right, up |

Frame counts per facing: Idle 12, Walk 6, attack 8, Death 7.

The old Kenney Tiny Dungeon tiles in `public/sprites/` stay put. They're CC0, they
are committed, and the DOM views (squad builder, roster, landing page) still use
them for static portraits.
