# TacticsLM — Gameplay Design (v1)

Decisions locked in before coding. Update this doc when design changes.

## Core concept

3v3 AI-vs-AI tactical grid combat. Each unit has its own independent LLM "brain."
Users are personality architects: they write each unit's behavioral prompt and pick
its loadout, then watch their squad fight.

## The grid

- **12×12** grid; some cells are **walls** (generated layouts). (Was 16×16; shrunk so matches land in the 3–5 minute target.)
- Engine handles **pathfinding (A\*)** and **line-of-sight** (raycast past walls).
- **LLM = intent, engine = legs:** the LLM picks a destination cell ("move to (7,3)");
  the engine validates reachability within move range and walks the unit around walls.
  The LLM never enumerates path steps.
- Each unit's prompt includes its set of reachable cells, so the model picks from
  valid options (cuts illegal-move retries). Could be loosened later to make spatial
  reasoning part of the AI challenge.

## Turn structure

- **Turn-based initiative order** (Option B), ordered by a **speed stat** (from items).
- Rejected simultaneous resolution: needs commit/reveal machinery and 6 parallel LLM
  calls with wildly varying latencies; messy.
- State machine: `whoseTurn → call brain → apply action → next`.
- On its turn, a unit's LLM receives: board state, recent team chat, its personality
  prompt + items → returns **one action** (move / attack / ability / wait) **plus a
  short message to teammates**.

## Comms

- No separate huddle phase in v1: a unit **speaks on its turn**, alongside its action.
- Messages are visible to **teammates only** — stored in SQLite, but the serving query
  filters by team so the opponent's client never receives them.
- Enemy messages are **revealed in the post-match replay** (reading the enemy huddle
  after the match is a feature).

## Units & loadouts

- **No classes/chassis** in v1 — **items-only builds**. Every unit starts from the
  same base statline; the loadout is the build. Classes emerge from item combos.
- Add chassis later only if builds feel samey.

### Base statline (before items)

- HP 20, Move 3, Speed 10 (initiative — higher acts first)
- **No innate attack** — the weapon is the only attack source.

### Slots (typed): weapon + helmet + chest + boots + 1 active + 2 consumables

**Weapons** (damage × range tradeoffs):
| Weapon | Range | Dmg | Quirk |
|---|---|---|---|
| Sword | 1 | 6 | +1 move |
| Spear | 2 | 5 | hits over adjacent unit |
| Bow | 5 | 4 | needs LoS |
| Crossbow | 6 | 6 | needs LoS, −3 speed |
| Dagger | 1 | 4 | +4 speed; +2 dmg if target already acted this round |
| Greatsword | 1 | 8 | −2 speed, −1 move |
| Rapier | 1 | 5 | +2 speed |
| Halberd | 2 | 6 | −2 speed |
| Sling | 4 | 3 | no LoS needed (lobbed) |

**Helmets:**
| Helmet | Effect |
|---|---|
| Great helm | +3 HP, −1 speed |
| Hood | +3 speed |
| Visor | +1 attack range (ranged weapons only) |
| Strategist's circlet | teammate messages can be 2× longer |
| Bascinet | +2 HP, +1 speed |
| Berserker mask | +2 damage, −2 HP |

**Chest:**
| Chest | Effect |
|---|---|
| Plate | +8 HP, −1 move, −2 speed |
| Chainmail | +5 HP, −1 speed |
| Leather | +3 HP |
| Cloak | +1 move; −1 dmg from first attack each round while not adjacent to an enemy |
| Brigandine | +6 HP, −1 move |
| Spiked armor | +4 HP; melee attackers take 1 dmg |

**Boots:**
| Boots | Effect |
|---|---|
| Greaves | +2 HP, −1 speed |
| Swiftboots | +1 move |
| Skirmisher's boots | +3 speed |
| Climbing hooks | may cross 1 wall cell per move |
| Heavy sabatons | +3 HP, −1 move |
| Scout boots | +1 move, +1 speed |

**Actives** (pick 1; **per-item cooldowns** — the balance dial; used instead of attacking):
| Active | Effect | CD |
|---|---|---|
| Heal pulse | +6 HP, range 3 or self | 3 |
| Smoke bomb | 3×3 blocks LoS for 1 round | 4 |
| Dash | +3 move this turn | 2 |
| Taunt | enemies in range 4 must target you next turn | 3 |
| Grenade | range 4, 3 dmg in 3×3, **friendly fire ON** | 4 |
| Shield wall | −2 dmg taken this round and next | 3 |
| Blink | teleport to free cell in range 3, through walls | 4 |

**Consumables** (pick 2; single-use; consuming = the turn's action, like attacking):
| Consumable | Effect |
|---|---|
| Health potion | +8 HP self |
| Adrenaline | +2 move, +4 speed for 2 rounds |
| Throwing knife | range 3, 3 dmg, no LoS (lobbed) |
| Antidote | removes debuffs (future-proofing) |
| Smoke vial | range 3, 3×3 LoS block for 1 round |
| Bomb | range 3, 2 dmg in 3×3, friendly fire |

### Turn action

`move (optional) → one of: attack / active / consumable / wait`. Move-then-act only
(no act-then-move in v1 — kiting balance).

### Deliberately excluded from v1

- Crit/dodge RNG — outcomes must be attributable to decisions, not luck.
- Item rarity/unlocks.

## Match flow

- **Room-based 1v1** (3 units each): create room → share code/link with a friend →
  both lock in squads → match runs → both spectate live (server pushes over a WebSocket).
- **Win condition:** elimination, or most total team HP at the round cap (10 rounds — matches target 3–5 minutes).

## Auth & accounts

- **Clerk** auth; sign-in required to play. The Clerk session token travels as a
  bearer token and is verified server-side in `server/auth.ts` on every request —
  the old anonymous localStorage token is gone.
- `users` table maps Clerk ids to app users (auto-created on the first authenticated
  request).
- **Roster**: `rosterUnits` table stores saved unit builds per user (name, personality,
  model, loadout) — reusable across rooms via load/save in the squad builder.
- Env: `VITE_CLERK_PUBLISHABLE_KEY` (frontend), `CLERK_SECRET_KEY` (server),
  `ADMIN_TOKEN` (dev harness routes only).

## LLM economics & architecture

- Users bring their own **OpenRouter key**, like PokerLM.
- **Key is never stored server-side** (leak prevention): lives in localStorage and is
  passed per-call to the brain route; it only transits, it is never written to the DB.
- **All LLM calls go through the backend** (PokerLM pattern, anti-cheat): the client
  posts `{matchId, apiKey}` to `POST /api/brain/act`. The server
  builds the prompt from a consistent snapshot (reachable cells, LoS,
  team chat — the client never sees the prompt), calls OpenRouter (AI SDK +
  structured output), retries up to 2× feeding rejection reasons back to the model,
  and falls back to `wait` so a confused model can't stall the match.
- `applyTurn` in `server/services/matches.ts` is reachable only from
  `server/services/brain.ts` — no route exposes it, so players cannot hand-craft
  actions (improvement over PokerLM, where the submit mutation is public). The
  rule is enforced by `server/services/applyTurn-boundary.test.ts`.
- Both players must keep a tab open during the match (their client triggers their
  own units' turns; fine for room-based play).
- Model choice per unit is itself a strategic lever (fast cheap vs slow smart).
  Possible future hook for a "fatigue" mechanic.

## Tech stack

- React 19 (Vite SPA) + Tailwind v4 + Motion, bun, oxlint/oxfmt
- Elysia on Bun + SQLite (Drizzle): game state, rooms, turn loop, replays (every
  turn is a row); live updates over a WebSocket
- Dev commands: `bun run dev` (app + server), `bun run play` (match harness),
  `bun run db:migrate` (schema), `bun run devtools` (recorded LLM calls)

## Build order

1. Schema (rooms, players, units, turns, messages) in `shared/schema.ts`
2. Deterministic engine (grid gen, reachability/A\*, LoS, action resolution)
3. Turn loop (client brain-runner + server validation)
4. UI (lobby/room, squad builder, live match view, replay)

## Open ideas (not v1)

- Message interception by nearby enemies
- Unit fatigue
- Chassis/classes on top of items
- Async matchmaking vs strangers
