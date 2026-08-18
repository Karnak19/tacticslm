# 🤖 TacticsLM

> 3 Bodies. 3 Brains. One Arena.

TacticsLM is an AI-vs-AI tactical grid arena where users design, program, and deploy teams of three distinct AI agents to compete in turn-based strategic combat. Unlike traditional simulation engines, each unit possesses its own individual LLM "brain," forcing teammates to communicate, negotiate, and coordinate their actions under pressure.

Built with **React**, **Tailwind CSS**, and **Elysia on Bun**.

---

## 🧬 The Core Essence

- **3 Brains, Not 1:** Teams do not share a single mind. Each unit runs on an independent LLM instance. They must navigate the friction of cooperation, manage misunderstandings, and execute localized tactics.
- **The Comms Phase:** Before physical execution on the grid, teammates enter a private "Huddle" phase to chat, argue, or align on a macro-strategy based on the current state.
- **User as Personality Architect:** Users design their squads by assigning physical chassis profiles, modular toolkits, and specific behavioral prompts (e.g., _The Arrogant Leader, The Anxious Support, The Reckless Diver_).

---

## 🛠️ Tech Stack

- **Frontend:** React 19 (Vite SPA) + Tailwind CSS. The board is a **Phaser 3** canvas; Motion drives the surrounding HUD — initiative bar, battle log, event ticker.
- **Backend & State Engine:** Elysia on Bun + SQLite via Drizzle (deterministic engine, transactional turn loop, live updates over a WebSocket)

---

## 🚀 Running it

New here? **[ONBOARDING.md](ONBOARDING.md)** goes from a clean machine to a running
match — Bun, Clerk, OpenRouter, the board art, and the four invariants worth knowing
before you change anything. The quick version:

```sh
bun install
bash scripts/setup-assets.sh # restore the gitignored CraftPix board art
bun run db:migrate           # bring data/tacticslm.db up to date (also runs at boot)
bun run dev                  # Vite on :5173, Elysia API on :4321

# Dev harness: seed a match and either watch it or drive it headless.
# Needs ADMIN_TOKEN set to the same value the server runs with.
export ADMIN_TOKEN=dev-secret
bun run play --watch         # seed, print the room URL, let the browser drive
bun run play --seed          # seed and drive here, printing the trace
bun run play --help          # every flag

bun run devtools             # inspect recorded LLM calls
```

Env: `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `ADMIN_TOKEN` for the
dev routes. Players bring their own OpenRouter key; it lives in the browser and is
never stored server-side.

---

## 🎨 Asset Credits

- Board art (Phaser renderer): [2D Top-Down Pixel Dungeon](https://craftpix.net/freebies/free-2d-top-down-pixel-dungeon-asset-pack/) and [Swordsman 1-3 Level](https://craftpix.net/freebies/free-swordsman-1-3-level-pixel-top-down-sprite-character-pack/) by [CraftPix](https://craftpix.net). Licensed for use, **not** for redistribution, so these files are gitignored — a fresh clone restores them with `bash scripts/setup-assets.sh` (see `public/sprites/craftpix/README.md`). The board renders as a bare grid until you do.
- Sprites & tiles (DOM views): [Tiny Dungeon](https://kenney.nl/assets/tiny-dungeon) by [Kenney](https://kenney.nl) (CC0)
- Item icons: [game-icons.net](https://game-icons.net) by Lorc, Delapouite, Carl Olsen, Willdabeast, DarkZaitzev, Lucas & contributors ([CC BY 3.0](https://creativecommons.org/licenses/by/3.0/))
