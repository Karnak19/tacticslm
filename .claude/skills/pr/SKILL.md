---
name: pr
description: Open a pull request on tacticslm, capture board screenshots, and drive the fouine review loop to green. Use when opening a PR, pushing a branch for review, asking what fouine says, answering review comments, or fixing findings from a review.
---

Read `.claude/skills/github-pr/SKILL.md` and run its procedure with these values.

## Settings

| Setting | Value | Notes |
|---|---|---|
| owner/repo | `Karnak19/tacticslm` | |
| frontend | **yes** | the game board is the product; UI changes need shots |
| target viewport | **1280x800** | not the 390x844 default — the board is a square canvas in a desktop layout and looks wrong cropped to a phone |
| review bot | `fouine-review` | check name is `fouine`; it reviews on push |
| merge style | squash | the `main` ruleset allows nothing else |
| screenshots heading | `## Board` | |
| build gate | `bun run build` | see below |

## The gate

`main` is protected by the `main` ruleset: PR required, **`ci` and `fouine` must both pass**, the branch must be up to date with `main`, squash-only, no force-pushes or deletions. No bypass actors — it applies to everyone.

Run before pushing:

```sh
bunx oxlint .    # lint
bun test         # includes the engine self-checks
bun run build    # tsc -b && vite build — the acceptance bar
```

Exactly what CI runs, in the same order, in about 20 seconds. `bun run build` owns the typecheck and goes last: lint and `tsc` can both pass while `vite build` fails.

## Screenshots

The board needs a running app and a signed-in session, which means two things the default procedure does not assume:

```sh
bun run dev      # Vite on :5173 AND Elysia on :4321 — both, one command
```

- A **match must exist** to screenshot the board. Seed one rather than clicking through the lobby as two players: `export ADMIN_TOKEN=<same value the server runs with>` then `bun run play --watch`, which prints a room URL. `seed-match` puts both teams under one user, so a single tab drives all six units.
- **Sign-in is Clerk**, so a headless browser cannot complete it. If you cannot drive an authenticated browser, say so in the PR body rather than silently skipping — that is the honest outcome, and it is what happened on #2 and #3.
- **The board is empty without the art.** `public/sprites/craftpix/` is gitignored (licensed for use, not redistribution); run `bash scripts/setup-assets.sh` first or you will screenshot a bare grid.

## Backend-only diffs

Most work here is `server/`, `shared/` or `convex`-era teardown with no visible change. Skip screenshots and say so in the body. The interesting review surface for those is the invariants, not pixels:

- `applyTurn` must stay reachable only from `server/services/brain.ts` — the LLM is the sole path to a turn, so players cannot hand-craft actions. `server/services/applyTurn-boundary.test.ts` enforces it.
- Team chat must never cross teams. `server/services/broadcast.ts` is the only module allowed to publish, and it throws if message text goes to a room channel.
- The per-match mutex in `server/services/lock.ts` is only correct because there is exactly one writer process.

Call these out in the PR body when a diff touches them; they are the things a reviewer cannot infer from the diff alone.
