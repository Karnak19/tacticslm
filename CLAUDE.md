<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Board art

The Phaser board (`src/game/BoardScene.ts`) renders CraftPix spritesheets from
`public/sprites/craftpix/`. That art is licensed for use but not redistribution,
so it is gitignored: run `bash scripts/setup-assets.sh` once per clone, or the
board comes up empty. The Kenney tiles in `public/sprites/` are CC0, committed,
and still used by the DOM views.
