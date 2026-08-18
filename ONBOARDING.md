# Getting set up

Everything you need to go from a clean machine to watching a match. Should take about 30 minutes, most of it waiting on account signups.

The one genuinely annoying step is the board art (step 5) — it needs a free CraftPix account and manual downloads, because the art is licensed for use but not redistribution and therefore cannot live in the repo. Start that signup early.

---

## 1. Bun

There is no Node in this project. Bun is the runtime, the package manager, the test runner and the bundler.

```sh
curl -fsSL https://bun.sh/install | bash
bun --version   # 1.3.13 is what CI pins; anything 1.3.x is fine locally
```

CI pins the exact version deliberately, so if something passes locally and fails in CI, a version mismatch is worth ruling out first.

## 2. Clone and install

```sh
git clone git@github.com:Karnak19/tacticslm.git
cd tacticslm
bun install
```

## 3. Clerk (sign-in)

Clerk handles authentication. You need your own development instance — do not ask for Basile's keys, dev instances are free and per-person.

1. Sign up at https://clerk.com and create an application.
2. Enable whatever sign-in method you like (email is simplest).
3. From the dashboard's **API keys** page, copy both keys.

Create `.env.local` in the repo root:

```sh
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...   # browser; must have the VITE_ prefix to be exposed
CLERK_SECRET_KEY=sk_test_...             # server only; never goes near the client
ADMIN_TOKEN=pick-any-string              # gates the dev-only routes, see step 7
```

`.env.local` is gitignored. If `CLERK_SECRET_KEY` is missing the server **refuses to boot** rather than starting and returning 401 to everything — a misconfigured key should not look like "my login is broken".

## 4. Database

SQLite, via Drizzle. Nothing to install.

```sh
bun run db:migrate
```

This creates `data/tacticslm.db`. The server also migrates on boot, so this step is really just so you can see it happen. It is idempotent — run it as often as you like.

**After changing `shared/schema.ts`:** `bunx drizzle-kit generate` to write the SQL, then `bun run db:migrate` to apply it. Note `drizzle-kit migrate` does **not** work here — drizzle-kit has no `bun:sqlite` driver and will ask you to install `better-sqlite3`. Don't. `generate` works fine; only applying is programmatic. There is more on this in `CLAUDE.md`.

## 5. Board art

The Phaser board renders CraftPix spritesheets. They are licensed for use but not redistribution, so they are gitignored and you fetch them yourself.

```sh
bash scripts/setup-assets.sh
```

If the zips are missing it tells you exactly which ones and where to get them. You need a free account at https://craftpix.net, then these two (the script names the other optional ones):

- https://craftpix.net/freebies/free-2d-top-down-pixel-dungeon-asset-pack/
- https://craftpix.net/freebies/free-swordsman-1-3-level-pixel-top-down-sprite-character-pack/

Leave the zips named as downloaded in `~/Downloads` and re-run the script. Skip this and the app still works — the board just renders as a bare grid, which is confusing enough to be worth avoiding.

## 6. OpenRouter (the AI)

Every unit is played by an LLM through OpenRouter. **The key is not a server env var** — it lives in your browser's localStorage and is passed per call, so it never gets stored server-side.

1. Get a key at https://openrouter.ai/keys. A few dollars of credit lasts a long time; a failed turn costs about $0.0006.
2. Start the app (step 7), then paste the key into the **KEY** field in the top-right nav.

It is stored under `tacticslm:openrouter-key`, so if you ever need it from devtools that is where it is. The terminal harness reads `OPENROUTER_API_KEY` from the environment instead.

## 7. Run it

```sh
bun run dev
```

One command, two processes: Vite on **:5173** with HMR, Elysia on **:4321**. Vite proxies `/api` and `/ws` across, so everything is same-origin and there is no CORS. Ctrl-C stops both.

Open http://localhost:5173, sign in, and your roster is created automatically on the first authenticated request — three starter units, no setup.

### Watching a match

A match needs two players, which is tedious solo, so seed one:

```sh
export ADMIN_TOKEN=<the same value as in .env.local>
bun run play --watch      # prints a room URL — open it and the browser plays the match
bun run play --seed       # plays it out in the terminal with a turn-by-turn trace
bun run play --help       # every flag, including --map-seed for a reproducible board
```

`--watch` puts both teams under your own user, so a single tab legitimately drives all six units. **Do not run `--watch` and `--seed` against the same match** — both will try to take the same turn, which is harmless but bills you twice.

### When the AI misbehaves

```sh
bun run devtools          # http://localhost:4983 — every LLM call, prompt and response
```

## 8. Before you push

```sh
bunx oxlint .
bun test                  # 107 tests
bun run build             # tsc -b && vite build — this is the bar
```

Exactly what CI runs. `bun run build` last on purpose: lint and typecheck can both pass while `vite build` fails.

`main` is protected — PR required, `ci` and `fouine` (the review bot) must both pass, branch must be up to date, squash-only, no force-pushes. No approval count, so you can merge your own once it is green.

There is a `pr` skill in `.claude/skills/pr/` if you use Claude Code; it carries the repo's conventions.

---

# Orientation

```
shared/      isomorphic — imported by BOTH the server and the browser
  engine.ts    the game rules. 750 lines, pure, no I/O. Start here.
  schema.ts    Drizzle tables
  catalog.ts   items and base stats
server/
  services/    all game logic. applyTurn, startMatch, takeTurn
  routes/      thin HTTP wrappers, Elysia
  db/          bun:sqlite connection + migrations
src/
  game/        Phaser scene (the board)
  components/  React UI around it
  hooks/       useRoomSocket — the live match subscription
scripts/       dev, migrate, play-match, setup-assets
```

**`shared/` must stay isomorphic.** An oxlint rule blocks it from importing `server/`, `node:*` or `bun`. This is load-bearing: Phaser code imports from `shared/`, so a server import there drags backend code into the browser bundle.

## Four things not to break

These are guarantees the code enforces on purpose, and each one is easy to undo without noticing:

1. **The LLM is the only path to a turn.** `applyTurn` is importable only from `server/services/brain.ts` — players must not be able to hand-craft actions. `server/services/applyTurn-boundary.test.ts` scans `server/routes/` and fails if it appears there.
2. **Team chat never crosses teams.** `server/services/broadcast.ts` is the only module allowed to publish to a socket, and it throws if message text goes to a room-wide channel. Each unit's prompt only ever contains its own team's messages. A single publish bundling both teams would look completely correct in the UI and leak the enemy's plans to anyone with devtools.
3. **One writer process.** `server/services/lock.ts` is an in-process per-match mutex making `applyTurn`'s read-check-write atomic. Convex used to give us this for free; SQLite does not. It is only correct while there is exactly one process writing — which is why the terminal harness talks over HTTP instead of opening the database file.
4. **`_id` and `_creationTime`** are deliberate column names, inherited from the Convex era. They keep ~1200 lines of view code compiling. Renaming them is a big diff for no gain.

Unit reasoning (`thinking`) is deliberately **public and live** — no prompt reads another unit's reasoning and a human takes no turns, so it is spectacle rather than secret. Team chat is the thing that is actually gated.

## Where things stand

The backend was migrated off Convex onto Elysia + SQLite very recently. The migration is proven: a full 60-turn match runs end to end.

**What is not proven is whether the units play well.** As of the last full match: 0 attacks in 60 turns, mostly because 43% of turns were lost to the model overrunning its token budget and returning unparseable JSON. That is fixed but has never faced a real model. If you want a first task with immediate feedback, run a match and see whether they actually fight — `bun run devtools` will show you why if they don't.

Read `DESIGN.md` for the game itself and `CLAUDE.md` for conventions that will otherwise bite you.

Welcome aboard.
