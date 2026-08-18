// The brain-runner: the only way a unit takes a turn. Port of `convex/brain.ts`.
//
// PokerLM-style — the client passes its OpenRouter key per call; the key only
// transits through this module and is never stored. The prompt is built
// server-side from a consistent snapshot, and the result is applied through
// `matches.applyTurn`, which no route may reach, so players cannot hand-craft
// actions.
//
// The model call lives behind the `DecisionGenerator` seam so the retry loop can
// be exercised without a network. `openRouterGenerator` is the real one (AI SDK
// v7 + @openrouter/ai-sdk-provider v3) and is the default. The scaffolding around
// it is the difference between "a confused model wastes a turn" and "the match
// hangs forever":
//   * MAX_LLM_RETRIES / LLM_TIME_BUDGET_MS,
//   * the rejected-decision retry that appends the assistant JSON plus the
//     rejection reason to `messages`,
//   * NoOutputGeneratedError getting ONE stricter retry and then breaking,
//   * diagnostics logged BEFORE `result.output` is touched,
//   * `isStaleTurnError` → skipped,
//   * the final safe `{kind:"wait"}` with the error in `thinking`.

import { and, desc, eq } from "drizzle-orm";
import { generateText, NoOutputGeneratedError, Output } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import type { CatalogItem } from "../../shared/catalog";
import {
  chebyshev,
  effectiveMove,
  hasLineOfSight,
  losBlockedCells,
  reachableCells,
  resolveStats,
} from "../../shared/engine";
import type {
  Action,
  Catalog,
  EngineUnit,
  Position,
  ResolvedStats,
  Snapshot,
} from "../../shared/engine";
import { matches, messages, players, units } from "../../shared/schema";
import type { Match, Unit } from "../../shared/types";
import type { Db, DbLike } from "../db/client";
import { applyTurn } from "./matches";
import { CATALOG_MAP, toEngineUnit, toSnapshot } from "./mappers";

const BASE_MESSAGE_BUDGET = 200;
const MAX_LLM_RETRIES = 2;
// Matches are meant to last 3-5 minutes, so one unit's turn cannot be allowed to
// eat 70+ seconds of it. Retries stop once this much wall time has been spent,
// even if the count budget is not exhausted.
const LLM_TIME_BUDGET_MS = 45_000;

// Must cover reasoning tokens as well as the decision JSON: reasoning counts
// against this cap even when `exclude: true` keeps it out of the response. At 800
// a reasoning model truncates mid-JSON, OpenRouter returns finish_reason
// "length", and the SDK's `result.output` getter throws NoOutputGeneratedError —
// after a perfectly successful 200.
export const LLM_MAX_OUTPUT_TOKENS = 2000;

const TEAM_CHAT_WINDOW = 12;

/**
 * Whether to keep the raw provider HTTP bodies in the step result, which is what
 * makes them show up in the AI SDK DevTools recording (`.devtools/`).
 *
 * OFF BY DEFAULT, ON PURPOSE. The player's OpenRouter key transits this module
 * per call (see the header) and DevTools writes what it captures to a plain-text
 * file. Inspection of `@ai-sdk/devtools` says the key cannot get there — it
 * stores `request.body`, the JSON payload, and never the Authorization header,
 * the provider settings or `createOpenRouter`'s headers — but "a third party's
 * serializer happens not to reach the secret today" is not a good enough reason
 * to write a user's credential-bearing request to disk by default. Turn it on
 * deliberately, for a debugging session, with
 * `AI_DEVTOOLS_RAW_BODIES=1 bun run dev`.
 */
const RECORD_RAW_BODIES =
  process.env.NODE_ENV !== "production" && process.env.AI_DEVTOOLS_RAW_BODIES === "1";

/**
 * `applyTurn` is racing with the match itself: while we were waiting on the model
 * the round may have advanced or the match may have ended. Those two errors mean
 * "we are stale", not "we are broken", and must never fail the call.
 */
export function isStaleTurnError(reason: string): boolean {
  return reason.includes("Not this unit's turn") || reason.includes("not running");
}

export type TurnContext = {
  match: Match;
  unit: Unit;
  units: Array<Unit>;
  teamChat: Array<{ from: string; turnNumber: number; text: string }>;
};

/**
 * Everything a turn needs, read in one consistent snapshot. `ownerUserId` gates
 * on whose unit it is; pass null to skip that check.
 *
 * The `items` read is gone (the table was dropped); the catalog is `CATALOG_MAP`.
 */
export function readTurnContext(
  db: DbLike,
  matchId: string,
  ownerUserId: string | null,
): TurnContext | null {
  const match = db.select().from(matches).where(eq(matches._id, matchId)).get();
  if (!match || match.status !== "running" || !match.currentUnitId) return null;
  const unit = db.select().from(units).where(eq(units._id, match.currentUnitId)).get();
  if (!unit) return null;
  if (ownerUserId !== null) {
    const player = db.select().from(players).where(eq(players._id, unit.playerId)).get();
    if (!player || player.userId !== ownerUserId) return null; // not your unit's turn
  }

  const all = db.select().from(units).where(eq(units.roomId, match.roomId)).all();
  const recent = db
    .select()
    .from(messages)
    .where(and(eq(messages.matchId, matchId), eq(messages.team, unit.team)))
    .orderBy(desc(messages.turnNumber), desc(messages._creationTime))
    .limit(TEAM_CHAT_WINDOW)
    .all();
  const unitNames = new Map(all.map((u) => [u._id, u.name]));

  return {
    match,
    unit,
    units: all,
    teamChat: recent.reverse().map((m) => ({
      from: unitNames.get(m.unitId) ?? "?",
      turnNumber: m.turnNumber,
      text: m.text,
    })),
  };
}

/**
 * The owner-gated read: only the signed-in commander of the current unit gets a
 * context back. This is the public path.
 */
export function turnContext(
  db: DbLike,
  matchId: string,
  userId: string | null,
): TurnContext | null {
  if (!userId) return null;
  return readTurnContext(db, matchId, userId);
}

/**
 * DEV ONLY: the same snapshot without the "is this your unit?" check, so the CLI
 * harness can drive both teams with no Clerk session. This is deliberately the
 * one auth bypass in the game; it must never be exposed on a route.
 */
export function unauthedTurnContext(db: DbLike, matchId: string): TurnContext | null {
  return readTurnContext(db, matchId, null);
}

/** The engine `Action`, but with real row ids. */
type DbAction = Action;

// Hard character cap on `thinking`. It exists in the schema, not just in prose,
// because prose failed: with reasoning disabled the model spent all 2000 output
// tokens narrating and 43% of turns died with finishReason "length" before the
// JSON reached `moveTo`/`action`. A zod `.max()` becomes a json-schema
// `maxLength`; with `structuredOutputs: { strict: false }` (load-bearing, see
// `openRouterGenerator`) not every provider enforces it, so this is one layer of
// three — the others are field order below and the length-retry in `takeTurn`.
export const THINKING_MAX_CHARS = 240;
export const MESSAGE_MAX_CHARS = 400;

// FIELD ORDER IS LOAD-BEARING. Fields are emitted in schema order, so `moveTo`
// and `action` are written BEFORE the flavour text: the model commits to a
// decision and then narrates it, instead of narrating its way into a decision it
// never records. That is the fix for the 18% of parsed turns whose `thinking`
// said "close the distance" while `moveTo` was null.
//
// The trade-off, stated plainly: `thinking` first was chain-of-thought, and
// moving it last gives that up. It is worth giving up here because the prompt
// already does the tactical work the model would have had to reason out —
// REACHABLE CELLS and ATTACK POSITIONS are precomputed with the engine's own
// range/LOS code, so a turn is mostly a lookup, not a derivation. It does NOT
// help against truncation on its own (a cut-off response is malformed JSON
// whatever the order); it helps because the decision is the part that gets
// written while the budget is still there.
const DecisionSchema = z.object({
  moveTo: z
    .union([z.object({ x: z.number().int(), y: z.number().int() }), z.null()])
    .describe(
      "REQUIRED. Decide this FIRST. Destination cell from your REACHABLE CELLS list. Use null ONLY if standing still is a deliberate tactical choice.",
    ),
  action: z.object({
    kind: z.enum(["attack", "active", "consumable", "wait"]),
    targetUnitName: z
      .string()
      .nullish()
      .describe("Exact name of the target unit (attack / heal / throwing_knife)."),
    targetCell: z
      .object({ x: z.number().int(), y: z.number().int() })
      .nullish()
      .describe("Target cell for area effects (smoke_bomb, grenade)."),
    consumableSlug: z.string().nullish().describe("Which consumable to use."),
  }),
  // `.overwrite` before `.max`: the cap reaches the provider as a json-schema
  // `maxLength`, but an over-long answer is TRUNCATED rather than rejected. A
  // plain `.max()` would fail validation and throw away an otherwise perfectly
  // good move — the opposite of the bug being fixed.
  thinking: z
    .string()
    .overwrite((v) => v.slice(0, THINKING_MAX_CHARS))
    .max(THINKING_MAX_CHARS)
    .describe(
      `In character, why you just chose that move and action. HARD LIMIT ${THINKING_MAX_CHARS} characters — one or two short sentences. Longer answers are cut off and the whole turn is lost. Shown in the post-match replay.`,
    ),
  message: z
    .string()
    .overwrite((v) => v.slice(0, MESSAGE_MAX_CHARS))
    .max(MESSAGE_MAX_CHARS)
    .nullish()
    .describe("Short message to your teammates, in character. They see it on their turns."),
});

export type Decision = z.infer<typeof DecisionSchema>;
export { DecisionSchema };

function describeItem(item: CatalogItem): string {
  return `${item.name} (${item.slug}): ${item.description}`;
}

// ---------------------------------------------------------------------------
// Spatial view helpers. Pure functions over the engine snapshot — no ctx and no
// database, so this is the same code that ran on Convex.
// Everything here reads the engine's own helpers; no rule is re-implemented.

const cellKey = (p: Position) => `${p.x},${p.y}`;

export type UnitSymbols = Map<string, string>; // engine unit id -> single char

// Deterministic single-char labels: `@` for the acting unit, digits for living
// allies, letters for living enemies, ordered by unit id so the same state always
// renders the same board. Dead units get no symbol: corpses neither block
// movement (reachableCells filters on `alive`) nor line of sight
// (losBlockedCells only knows walls and smoke), so drawing them would invent a
// piece of terrain the rules do not have.
export function assignUnitSymbols(snapshot: Snapshot, meId: string): UnitSymbols {
  const me = snapshot.units.find((u) => u.id === meId);
  const symbols: UnitSymbols = new Map();
  if (me) symbols.set(me.id, "@");
  const living = snapshot.units
    .filter((u) => u.alive && u.id !== meId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let allyIndex = 0;
  let enemyIndex = 0;
  for (const u of living) {
    if (me && u.team === me.team) {
      symbols.set(u.id, String(1 + allyIndex));
      allyIndex += 1;
    } else {
      symbols.set(u.id, "ABCDEFGH"[enemyIndex] ?? "?");
      enemyIndex += 1;
    }
  }
  return symbols;
}

// ASCII board with row/column indices, so the model can read a coordinate off the
// map instead of counting cells. Columns are space-separated to survive a
// proportional font. Reachable-but-empty cells are drawn as `+`.
export function renderMap(
  snapshot: Snapshot,
  symbols: UnitSymbols,
  reachable: Array<Position>,
): string {
  const size = snapshot.gridSize;
  const wide = size > 10;
  const pad = (n: number) => (wide ? String(n).padStart(2, " ") : String(n));
  const walls = new Set(snapshot.walls.map(cellKey));
  const smoke = new Set<string>();
  for (const e of snapshot.effects) {
    if (e.kind === "smoke" && e.expiresAfterRound >= snapshot.roundNumber) {
      for (const c of e.cells) smoke.add(cellKey(c));
    }
  }
  const reach = new Set(reachable.map(cellKey));
  const occupants = new Map<string, string>();
  for (const u of snapshot.units) {
    const s = symbols.get(u.id);
    if (s && u.alive) occupants.set(cellKey(u.position), s);
  }

  const cellChar = (x: number, y: number): string => {
    const k = `${x},${y}`;
    const who = occupants.get(k);
    if (who) return who;
    if (walls.has(k)) return "#";
    if (smoke.has(k)) return "~";
    if (reach.has(k)) return "+";
    return ".";
  };

  const header = `${wide ? "   " : "  "} ${Array.from({ length: size }, (_, x) => pad(x)).join(" ")}`;
  const rows = Array.from({ length: size }, (_, y) => {
    const cells = Array.from({ length: size }, (_, x) =>
      wide ? ` ${cellChar(x, y)}` : cellChar(x, y),
    );
    return `${wide ? String(y).padStart(2, " ") : String(y)}  ${cells.join(" ")}`;
  });
  return [header, ...rows].join("\n");
}

export type AttackPosition = {
  cell: Position;
  isCurrent: boolean;
  targets: Array<string>; // enemy names hittable from this cell
  exposedTo: Array<string>; // map symbols of enemies whose current range covers it
};

// For every cell the unit can end its move on (plus staying put), which enemies
// it could attack from there — same range/LOS test the engine uses in
// `resolveTurn`. This is the thing the model cannot work out for itself: line of
// sight is otherwise only ever reported from where the unit already stands.
export function attackPositions(
  snapshot: Snapshot,
  me: EngineUnit,
  stats: ResolvedStats,
  reachable: Array<Position>,
  catalog: Catalog,
  symbols: UnitSymbols,
): Array<AttackPosition> {
  const blocked = losBlockedCells(snapshot);
  const enemies = snapshot.units.filter((u) => u.alive && u.team !== me.team);
  const threats = enemies.map((e) => ({ unit: e, stats: resolveStats(e.loadout, catalog) }));

  const candidates: Array<{ cell: Position; isCurrent: boolean }> = [
    { cell: me.position, isCurrent: true },
    ...reachable.map((cell) => ({ cell, isCurrent: false })),
  ];

  const canHit = (from: Position, target: EngineUnit, range: number, needsLos: boolean) =>
    chebyshev(from, target.position) <= range &&
    (!needsLos || hasLineOfSight(from, target.position, blocked));

  return candidates
    .map(({ cell, isCurrent }) => ({
      cell,
      isCurrent,
      targets: enemies
        .filter((e) => canHit(cell, e, stats.attackRange, stats.needsLos))
        .map((e) => e.name),
      // Deliberately simple threat model: an enemy's range from where it stands
      // right now. Folding in enemy move budgets would mark nearly every cell and
      // tell the model nothing.
      exposedTo: threats
        .filter(
          (t) =>
            chebyshev(t.unit.position, cell) <= t.stats.attackRange &&
            (!t.stats.needsLos || hasLineOfSight(t.unit.position, cell, blocked)),
        )
        .map((t) => symbols.get(t.unit.id) ?? t.unit.name),
    }))
    .filter((p) => p.targets.length > 0);
}

export function formatAttackPositions(positions: Array<AttackPosition>): string {
  if (positions.length === 0) {
    return "(none — no cell you can reach lets you attack anyone this turn)";
  }
  return positions
    .map((p) => {
      const where = p.isCurrent ? "(stay put)" : `(${p.cell.x},${p.cell.y})`;
      const exposure =
        p.exposedTo.length > 0 ? ` [under fire from ${p.exposedTo.join(",")}]` : " [safe]";
      return `- ${where} -> can hit ${p.targets.join(", ")}${exposure}`;
    })
    .join("\n");
}

export function buildPrompt(ctxData: TurnContext): { system: string; user: string } {
  const { match, unit, units: all, teamChat } = ctxData;
  const catalog = CATALOG_MAP;
  const snapshot = toSnapshot(match, all);
  const me = toEngineUnit(unit);
  const stats = resolveStats(me.loadout, catalog);
  const moveBudget = effectiveMove(
    me,
    stats,
    snapshot.effects.filter((e) => e.expiresAfterRound >= snapshot.roundNumber),
  );
  const reachable = reachableCells(me.position, moveBudget, snapshot, {
    crossesWalls: stats.crossesWalls,
  });
  const blocked = losBlockedCells(snapshot);

  const symbols = assignUnitSymbols(snapshot, me.id);
  const board = renderMap(snapshot, symbols, reachable);
  const shots = attackPositions(snapshot, me, stats, reachable, catalog, symbols);

  const allies = all.filter((u) => u.team === unit.team && u._id !== unit._id);
  const enemies = all.filter((u) => u.team !== unit.team);
  const describeUnit = (u: Unit) => {
    const eu = toEngineUnit(u);
    if (!eu.alive) return `- ${u.name}: DEAD (not on the map)`;
    const dist = chebyshev(me.position, eu.position);
    const los = hasLineOfSight(me.position, eu.position, blocked);
    return `- [${symbols.get(eu.id) ?? "?"}] ${u.name} at (${eu.position.x},${eu.position.y}), HP ${eu.hp}, distance ${dist}${los ? "" : ", NO line of sight"}`;
  };

  const gear = [me.loadout.weapon, me.loadout.helmet, me.loadout.chest, me.loadout.boots]
    .map((slug) => describeItem(catalog.get(slug)!))
    .join("\n");
  const activeItem = catalog.get(me.loadout.active)!;
  const consumables = me.loadout.consumables
    .map((slug) => {
      const used = me.usedConsumables.includes(slug);
      return `${describeItem(catalog.get(slug)!)}${used ? " [ALREADY USED]" : ""}`;
    })
    .join("\n");

  const system = `You are ${unit.name}, a combat unit in a 3v3 tactical grid arena. You have your own mind; your two teammates are separate AIs you can only influence by talking to them.

YOUR PERSONALITY (stay in character at all times):
${unit.personality}

RULES:
- The grid is ${match.gridSize}x${match.gridSize}; (0,0) is top-left, x grows right, y grows down. Walls are impassable and block line of sight; smoke blocks line of sight only.
- On your turn you may MOVE (optional) and then take ONE action: attack, active ability, consumable, or wait.
- Only pick moveTo from your REACHABLE CELLS list.
- Attacks need the target within your weapon range${stats.needsLos ? " and line of sight" : ""}.
- Your message to teammates is limited to ${BASE_MESSAGE_BUDGET * stats.messageBudgetMultiplier} characters.
- If your action is illegal it will be rejected and you will be asked again; repeated failures waste your turn.
- Fill moveTo and action FIRST, then write thinking to explain what you just chose. A null moveTo means you stand still, so if you mean to advance, retreat or flank, moveTo MUST contain the cell.
- Never use your active ability on a no-op: no healing a unit that is already at full HP, no buff that changes nothing. If the active would do nothing, attack or move instead.
- The match ends at the round cap: the team with more total HP wins. If ATTACK POSITIONS lists a cell, moving there and attacking is almost always right. If it is empty, use the map to close the distance — pick a reachable cell that puts a wall between you and their shooters, or that will open a shot next turn. Holding still with no shot on offer is how you lose on points.`;

  const myTeamHp = all
    .filter((u) => u.team === unit.team)
    .reduce((sum, u) => sum + (u.alive ? (u.hp ?? 0) : 0), 0);
  const enemyTeamHp = all
    .filter((u) => u.team !== unit.team)
    .reduce((sum, u) => sum + (u.alive ? (u.hp ?? 0) : 0), 0);
  const standing =
    myTeamHp > enemyTeamHp
      ? "Your team is AHEAD on HP — if the round cap hits, you win."
      : myTeamHp < enemyTeamHp
        ? "Your team is BEHIND on HP — if nothing changes by the round cap, YOU LOSE. Passivity is defeat."
        : "Teams are TIED on HP — a draw at the cap. You need damage to win.";

  const user = `ROUND ${match.roundNumber} of ${match.turnCap}. Team HP: yours ${myTeamHp} vs theirs ${enemyTeamHp}. ${standing}
You are at (${me.position.x},${me.position.y}) with ${me.hp} HP.

YOUR GEAR:
${gear}

YOUR ACTIVE ABILITY:
${describeItem(activeItem)}${me.activeCooldown > 0 ? ` [ON COOLDOWN: ${me.activeCooldown} more round(s)]` : " [READY]"}

YOUR CONSUMABLES:
${consumables}

YOUR STATS: move ${moveBudget}, attack range ${stats.attackRange}, damage ${stats.damage}, speed ${stats.speed}.

TEAMMATES:
${allies.map(describeUnit).join("\n") || "(none alive)"}

ENEMIES:
${enemies.map(describeUnit).join("\n")}

MAP (row = y, column = x; read a cell as (column,row)):
${board}
Legend: @ you · 1-2 allies · A-C enemies (see lists above) · # wall (blocks movement and sight) · ~ smoke (blocks sight, not movement) · + a cell you can move to · . empty

ATTACK POSITIONS (where you could move so you can attack this turn):
${formatAttackPositions(shots)}

REACHABLE CELLS (pick moveTo from these, or null to stay):
${reachable.map((c) => `(${c.x},${c.y})`).join(" ")}

TEAM CHAT (most recent last):
${teamChat.map((m) => `[turn ${m.turnNumber}] ${m.from}: ${m.text}`).join("\n") || "(no messages yet)"}

Decide your turn.`;

  return { system, user };
}

/**
 * Map the LLM's name-based decision to row ids; invalid names throw and trigger a
 * retry with the error appended.
 */
export function toEngineAction(decision: Decision, ctxData: TurnContext): DbAction {
  const { action } = decision;
  const findUnit = (name: string | null | undefined): string => {
    const found = ctxData.units.find((u) => u.name.toLowerCase() === (name ?? "").toLowerCase());
    if (!found) throw new Error(`No unit named "${name}"`);
    return found._id;
  };
  switch (action.kind) {
    case "wait":
      return { kind: "wait" };
    case "attack":
      return { kind: "attack", targetUnitId: findUnit(action.targetUnitName) };
    case "active":
      return {
        kind: "active",
        targetCell: action.targetCell ?? undefined,
        targetUnitId: action.targetUnitName ? findUnit(action.targetUnitName) : undefined,
      };
    case "consumable": {
      if (!action.consumableSlug) throw new Error("consumableSlug is required");
      return {
        kind: "consumable",
        slug: action.consumableSlug,
        targetCell: action.targetCell ?? undefined,
        targetUnitId: action.targetUnitName ? findUnit(action.targetUnitName) : undefined,
      };
    }
  }
}

export type TurnResult = { status: "ok" | "skipped" | "error"; reason?: string };

/** What one model call produces, plus the diagnostics we log before reading it. */
export type GeneratedDecision = {
  decision: Decision;
  finishReason?: string;
  usage?: unknown;
  warnings?: Array<unknown>;
};

/**
 * The seam the AI SDK call lives behind. `takeTurn` takes one so the retry loop
 * can be exercised without a network, and so the later AI-SDK-v7 stage has one
 * function to fill in rather than a loop to re-derive.
 */
export type DecisionGenerator = (input: {
  model: string;
  apiKey: string;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxOutputTokens: number;
}) => Promise<GeneratedDecision>;

/**
 * The real model call — AI SDK v7 + `@openrouter/ai-sdk-provider` v3.
 *
 * Every setting below is a fixed production bug, not a preference. Do not tidy
 * them away:
 *
 *   * `reasoning: { enabled: false, effort: "none" }` — NOT `{effort:"minimal",
 *     exclude:true}`. Measured: nemotron ignored "minimal" and spent 1372 of a
 *     2000-token budget thinking, leaving too little to finish the JSON
 *     (finishReason "length" -> NoOutputGeneratedError). `DecisionSchema` has a
 *     `thinking` field, so the model's reasoning still reaches us readably
 *     instead of being billed and then discarded.
 *   * `provider: { require_parameters: true }` — without it OpenRouter is free to
 *     route to a provider that ignores json_schema structured output, which
 *     answers with an empty body and kills every turn.
 *   * `structuredOutputs: { strict: false }` — load-bearing alongside the above:
 *     open-weight models on non-OpenAI-compatible providers mostly do not
 *     advertise *strict* json_schema, so leaving strict at its default of true
 *     makes require_parameters exclude nearly all of them and can leave no
 *     eligible provider at all.
 *   * `maxOutputTokens: LLM_MAX_OUTPUT_TOKENS` (2000, not 800) — reasoning
 *     tokens count against the cap even when they are excluded.
 *   * No client-side timeout. Aborting mid-response caused spurious failures;
 *     `LLM_TIME_BUDGET_MS` in `takeTurn` is what bounds the turn.
 *
 * Note the shape of the return: the diagnostics are read here, eagerly, and the
 * `decision` is read LAST. `result.output` is a getter that throws when
 * `finishReason !== "stop"`, and anything not read before it is lost.
 */
export const openRouterGenerator: DecisionGenerator = async ({
  model,
  apiKey,
  system,
  messages,
  maxOutputTokens,
}) => {
  // OpenRouter app attribution: https://openrouter.ai/docs/app-attribution
  const openrouter = createOpenRouter({
    apiKey,
    headers: {
      "HTTP-Referer": "https://github.com/karnak19/tacticslm",
      "X-Title": "TacticsLM",
      "X-OpenRouter-Categories": "game",
    },
  });

  const result = await generateText({
    model: openrouter.chat(model, {
      reasoning: { enabled: false, effort: "none" },
      provider: { require_parameters: true },
      structuredOutputs: { strict: false },
    }),
    output: Output.object({ schema: DecisionSchema }),
    system,
    messages,
    temperature: 0.7,
    maxOutputTokens,
    // Opt-in only; see RECORD_RAW_BODIES above. Default (`undefined`) is the
    // SDK's own default of excluding both.
    include: RECORD_RAW_BODIES ? { requestBody: true, responseBody: true } : undefined,
  });

  const finishReason = result.finishReason;
  const usage = result.usage;
  const warnings = result.warnings as Array<unknown> | undefined;

  let decision: Decision;
  try {
    decision = result.output;
  } catch (e) {
    // The getter threw, so `takeTurn` will only ever see the exception. Log the
    // diagnostics we captured above or the diagnosis is gone: this is exactly
    // what turned an opaque NoOutputGeneratedError into "the model spent the
    // whole budget reasoning".
    console.error(
      `brain: output unreadable (${model}): finishReason=${finishReason}`,
      `usage=${JSON.stringify(usage)}`,
      warnings?.length ? `warnings=${JSON.stringify(warnings)}` : "",
    );
    throw e;
  }
  return { decision, finishReason, usage, warnings };
};

/**
 * Play one turn: prompt the unit's model, retry on illegal decisions, apply the
 * result. Shared by the public path and the dev harness, so the harness exercises
 * the real brain and not a copy of it.
 */
export async function takeTurn(
  db: Db,
  matchId: string,
  apiKey: string,
  ctxData: TurnContext,
  generate: DecisionGenerator = openRouterGenerator,
): Promise<TurnResult> {
  const { system, user } = buildPrompt(ctxData);
  let lastError = "";
  // One stricter retry after a truncated (finishReason "length") response, ever.
  let lengthRetried = false;
  const chat: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: user },
  ];

  const deadline = Date.now() + LLM_TIME_BUDGET_MS;
  for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt++) {
    if (attempt > 0 && Date.now() > deadline) {
      console.error(
        `brain.takeTurn giving up after ${attempt} attempt(s): ${LLM_TIME_BUDGET_MS}ms budget spent`,
      );
      break;
    }
    let decision: Decision;
    const startedAt = Date.now();
    try {
      const result = await generate({
        model: ctxData.unit.model,
        apiKey,
        system,
        messages: chat,
        maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
      });
      // Read the diagnostics BEFORE touching the decision: in the AI SDK the
      // `.output` getter throws when finishReason !== "stop", and anything read
      // after it is lost.
      if (result.finishReason !== "stop" || result.warnings?.length) {
        console.warn(
          `brain.takeTurn attempt ${attempt + 1} (${ctxData.unit.model}): finishReason=${result.finishReason}`,
          `usage=${JSON.stringify(result.usage)}`,
          result.warnings?.length ? `warnings=${JSON.stringify(result.warnings)}` : "",
        );
      }
      decision = result.decision;
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      lastError = e instanceof Error ? e.message : String(e);
      console.error(
        `brain.takeTurn LLM call failed after ${Date.now() - startedAt}ms (${ctxData.unit.model}, attempt ${attempt + 1}):`,
        detail,
      );
      // A truncated response is a property of the request, not bad luck: an
      // IDENTICAL retry truncates identically and just burns the budget. So retry
      // exactly once, and only with a genuinely different request — one that
      // tells the model its last answer was too long. Anything beyond that is
      // the blind retrying this guard was added to stop.
      if (NoOutputGeneratedError.isInstance(e)) {
        if (lengthRetried || Date.now() > deadline) {
          console.error("brain.takeTurn: no output generated — not retrying an identical request");
          break;
        }
        lengthRetried = true;
        console.warn("brain.takeTurn: output truncated — one stricter retry");
        chat.push({
          role: "user",
          content: `Your previous response was too long and was cut off before the JSON was complete, so the turn was lost. Answer again. Put moveTo and action first, keep "thinking" under ${THINKING_MAX_CHARS} characters and "message" under ${MESSAGE_MAX_CHARS} (or null). Do not explain yourself beyond that.`,
        });
        continue;
      }
      continue; // retry; falls through to the safe default after MAX_LLM_RETRIES
    }

    try {
      const engineAction = toEngineAction(decision, ctxData);
      await applyTurn(db, {
        matchId,
        unitId: ctxData.unit._id,
        moveTo: decision.moveTo ?? undefined,
        action: engineAction,
        message: decision.message ?? undefined,
        thinking: decision.thinking,
      });
      return { status: "ok" };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (isStaleTurnError(reason)) {
        return { status: "skipped", reason: "turn already taken" };
      }
      chat.push(
        { role: "assistant", content: JSON.stringify(decision) },
        {
          role: "user",
          content: `Your decision was rejected: ${reason}. Choose a different, legal move/action.`,
        },
      );
    }
  }

  // Safe default so a confused model can't stall the match. Surface the failure
  // reason so players can tell "model error" from "chose to wait". The retries can
  // easily outlive the turn, so this call has to tolerate a match that moved on or
  // ended underneath us just like the loop above does.
  try {
    await applyTurn(db, {
      matchId,
      unitId: ctxData.unit._id,
      action: { kind: "wait" },
      thinking: `(brain error — holding position. ${lastError.slice(0, 300)})`,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (isStaleTurnError(reason)) {
      return { status: "skipped", reason: "turn already taken" };
    }
    throw e;
  }
  return { status: "ok", reason: "defaulted to wait" };
}

/** The public entry point: read the owner-gated context, then play. */
export async function act(
  db: Db,
  matchId: string,
  userId: string | null,
  apiKey: string,
  generate?: DecisionGenerator,
): Promise<TurnResult> {
  const ctxData = turnContext(db, matchId, userId);
  if (!ctxData) return { status: "skipped", reason: "not your turn" };
  return await takeTurn(db, matchId, apiKey, ctxData, generate);
}
