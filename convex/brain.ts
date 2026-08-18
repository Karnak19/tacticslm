// The brain-runner: the only way a unit takes a turn.
// PokerLM-style — the client passes its OpenRouter key per call; the key only
// transits through this action and is never stored. The prompt is built
// server-side from a consistent snapshot, and the result is applied via an
// internal mutation, so players cannot hand-craft actions.

import { v } from "convex/values";
import { z } from "zod";
import { generateText, NoOutputGeneratedError, Output } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { action, internalQuery } from "./_generated/server";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { docsToCatalog, toEngineUnit, toSnapshot } from "./lib/db";
import {
  chebyshev,
  effectiveMove,
  hasLineOfSight,
  losBlockedCells,
  reachableCells,
  resolveStats,
} from "./lib/engine";
import type { Catalog, EngineUnit, Position, ResolvedStats, Snapshot } from "./lib/engine";
import type { CatalogItem } from "./lib/catalog";
import { currentUser } from "./lib/auth";

const BASE_MESSAGE_BUDGET = 200;
const MAX_LLM_RETRIES = 2;
// Matches are meant to last 3-5 minutes, so one unit's turn cannot be allowed to
// eat 70+ seconds of it. Retries stop once this much wall time has been spent,
// even if the count budget is not exhausted.
const LLM_TIME_BUDGET_MS = 45_000;

// Must cover reasoning tokens as well as the decision JSON: reasoning counts
// against this cap even when `exclude: true` keeps it out of the response.
const LLM_MAX_OUTPUT_TOKENS = 2000;

// applyTurn is racing with the match itself: while we were waiting on the model
// the round may have advanced or the match may have ended. Those two errors mean
// "we are stale", not "we are broken", and must never fail the action.
function isStaleTurnError(reason: string): boolean {
  return reason.includes("Not this unit's turn") || reason.includes("not running");
}

// Everything the action needs, read in one consistent snapshot. `ownerUserId`
// gates on whose unit it is; pass null to skip that check (dev harness only).
async function readTurnContext(
  ctx: QueryCtx,
  matchId: Id<"matches">,
  ownerUserId: Id<"users"> | null,
): Promise<TurnContext | null> {
  const match = await ctx.db.get(matchId);
  if (!match || match.status !== "running" || !match.currentUnitId) return null;
  const unit = await ctx.db.get(match.currentUnitId);
  if (!unit) return null;
  if (ownerUserId !== null) {
    const player = await ctx.db.get(unit.playerId);
    if (!player || player.userId !== ownerUserId) return null; // not your unit's turn
  }

  const units = await ctx.db
    .query("units")
    .withIndex("by_room", (q) => q.eq("roomId", match.roomId))
    .collect();
  const messages = await ctx.db
    .query("messages")
    .withIndex("by_match_and_team", (q) => q.eq("matchId", matchId).eq("team", unit.team))
    .order("desc")
    .take(12);
  const items = await ctx.db.query("items").collect();
  const unitNames = new Map(units.map((u) => [u._id as string, u.name]));

  return {
    match,
    unit,
    units,
    items,
    teamChat: messages.reverse().map((m) => ({
      from: unitNames.get(m.unitId as string) ?? "?",
      turnNumber: m.turnNumber,
      text: m.text,
    })),
  };
}

export const turnContext = internalQuery({
  args: { matchId: v.id("matches") },
  // Explicit annotation: `act` calls this through `internal.brain.turnContext`,
  // which TypeScript cannot resolve without it (TS7022 circularity).
  handler: async (ctx, args): Promise<TurnContext | null> => {
    const user = await currentUser(ctx);
    if (!user) return null;
    return await readTurnContext(ctx, args.matchId, user._id);
  },
});

// DEV ONLY (see convex/dev.ts): same snapshot, without the "is this your unit?"
// check, so the CLI harness can drive both teams with no Clerk session. Internal
// on purpose — this is deliberately the one auth bypass in the game.
export const unauthedTurnContext = internalQuery({
  args: { matchId: v.id("matches") },
  handler: async (ctx, args): Promise<TurnContext | null> => {
    return await readTurnContext(ctx, args.matchId, null);
  },
});

export type TurnContext = {
  match: Doc<"matches">;
  unit: Doc<"units">;
  units: Array<Doc<"units">>;
  items: Array<Doc<"items">>;
  teamChat: Array<{ from: string; turnNumber: number; text: string }>;
};

// The action validator's shape (engine Action, but with real document ids).
type DbAction =
  | { kind: "attack"; targetUnitId: Id<"units"> }
  | { kind: "active"; targetCell?: { x: number; y: number }; targetUnitId?: Id<"units"> }
  | {
      kind: "consumable";
      slug: string;
      targetCell?: { x: number; y: number };
      targetUnitId?: Id<"units">;
    }
  | { kind: "wait" };

const DecisionSchema = z.object({
  thinking: z
    .string()
    .describe(
      "Your tactical reasoning, in character — 2 or 3 sentences MAX. Shown in the post-match replay.",
    ),
  moveTo: z
    .union([z.object({ x: z.number().int(), y: z.number().int() }), z.null()])
    .describe(
      "REQUIRED. Destination cell from your REACHABLE CELLS list. Use null ONLY if standing still is a deliberate tactical choice. If your thinking says you advance/retreat/flank, this field MUST contain the cell.",
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
  message: z
    .string()
    .nullish()
    .describe("Short message to your teammates, in character. They see it on their turns."),
});

function describeItem(item: CatalogItem): string {
  return `${item.name} (${item.slug}): ${item.description}`;
}

// ---------------------------------------------------------------------------
// Spatial view helpers. Pure functions over the engine snapshot — no Convex ctx,
// so the Elysia port (server/services/brain.ts) is a move, not a rewrite.
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
    const cells = Array.from({ length: size }, (_, x) => (wide ? ` ${cellChar(x, y)}` : cellChar(x, y)));
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
  const { match, unit, units, items, teamChat } = ctxData;
  const catalog = docsToCatalog(items);
  const snapshot = toSnapshot(match, units);
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

  const allies = units.filter((u) => u.team === unit.team && u._id !== unit._id);
  const enemies = units.filter((u) => u.team !== unit.team);
  const describeUnit = (u: (typeof units)[number]) => {
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
- Your decision fields must match your thinking: if you plan to move, SET moveTo. A null moveTo means you stand still.
- The match ends at the round cap: the team with more total HP wins. If ATTACK POSITIONS lists a cell, moving there and attacking is almost always right. If it is empty, use the map to close the distance — pick a reachable cell that puts a wall between you and their shooters, or that will open a shot next turn. Holding still with no shot on offer is how you lose on points.`;

  const myTeamHp = units
    .filter((u) => u.team === unit.team)
    .reduce((sum, u) => sum + (u.alive ? (u.hp ?? 0) : 0), 0);
  const enemyTeamHp = units
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

// Map the LLM's name-based decision to engine ids; invalid names throw and
// trigger a retry with the error appended.
function toEngineAction(decision: z.infer<typeof DecisionSchema>, ctxData: TurnContext): DbAction {
  const { action } = decision;
  const findUnit = (name: string | null | undefined): Id<"units"> => {
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

export type TurnResult = {
  status: "ok" | "skipped" | "error";
  reason?: string;
};

export const turnResultValidator = v.object({
  status: v.union(v.literal("ok"), v.literal("skipped"), v.literal("error")),
  reason: v.optional(v.string()),
});

export const act = action({
  args: { matchId: v.id("matches"), apiKey: v.string() },
  returns: turnResultValidator,
  handler: async (ctx, args): Promise<TurnResult> => {
    const ctxData: TurnContext | null = await ctx.runQuery(internal.brain.turnContext, {
      matchId: args.matchId,
    });
    if (!ctxData) return { status: "skipped" as const, reason: "not your turn" };
    return await takeTurn(ctx, args.matchId, args.apiKey, ctxData);
  },
});

// Play one turn: prompt the unit's model, retry on illegal decisions, apply the
// result. Shared verbatim by the public `act` above and by `dev:act`, so the dev
// harness exercises the real brain and not a copy of it.
export async function takeTurn(
  ctx: ActionCtx,
  matchId: Id<"matches">,
  apiKey: string,
  ctxData: TurnContext,
): Promise<TurnResult> {
  {
    // OpenRouter app attribution: https://openrouter.ai/docs/app-attribution
    const openrouter = createOpenRouter({
      apiKey,
      headers: {
        "HTTP-Referer": "https://github.com/karnak19/tacticslm",
        "X-Title": "TacticsLM",
        "X-OpenRouter-Categories": "game",
      },
    });

    const { system, user } = buildPrompt(ctxData);
    let lastError = "";
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: user },
    ];

    const deadline = Date.now() + LLM_TIME_BUDGET_MS;
    for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt++) {
      if (attempt > 0 && Date.now() > deadline) {
        console.error(
          `brain.act giving up after ${attempt} attempt(s): ${LLM_TIME_BUDGET_MS}ms budget spent`,
        );
        break;
      }
      let decision: z.infer<typeof DecisionSchema>;
      const startedAt = Date.now();
      try {
        // No client-side timeout: Convex caps actions at 10 minutes, and
        // aborting mid-response was causing spurious failures.
        const result = await generateText({
          model: openrouter.chat(ctxData.unit.model, {
            // Reasoning off, not merely "minimal": nemotron ignored minimal and
            // spent 1372 of a 2000-token budget thinking, leaving too little to
            // finish the JSON (finishReason "length" -> NoOutputGeneratedError).
            // DecisionSchema already has a `thinking` field, so the model's
            // reasoning still reaches us somewhere we can actually read it,
            // instead of being billed and then discarded by `exclude`.
            reasoning: { enabled: false, effort: "none" },
            // Without this, OpenRouter is free to route to a provider that
            // ignores json_schema structured output (and the reasoning params),
            // which answers with an empty body -> AI_NoOutputGeneratedError on
            // every turn. require_parameters keeps routing to providers that
            // actually support everything we ask for, without pinning a vendor.
            provider: { require_parameters: true },
            // Open-weight models routed through non-OpenAI-compatible providers
            // mostly do not advertise *strict* json_schema; leaving strict at
            // its default of true would make require_parameters exclude nearly
            // all of them and leave no eligible provider at all.
            structuredOutputs: { strict: false },
          }),
          output: Output.object({ schema: DecisionSchema }),
          system,
          messages,
          temperature: 0.7,
          // Reasoning tokens are billed against this cap even though
          // `exclude: true` hides them from us. At 800 a reasoning model
          // truncates mid-JSON, OpenRouter returns finish_reason "length", and
          // the SDK's `result.output` getter throws NoOutputGeneratedError --
          // after a perfectly successful 200. The decision object is tiny; the
          // headroom is for the thinking we never see.
          maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
        });
        // Read the diagnostics BEFORE touching `.output`: that getter throws
        // when finishReason !== "stop", and anything read after it is lost.
        if (result.finishReason !== "stop" || result.warnings?.length) {
          console.warn(
            `brain.act attempt ${attempt + 1} (${ctxData.unit.model}): finishReason=${result.finishReason}`,
            `usage=${JSON.stringify(result.usage)}`,
            result.warnings?.length ? `warnings=${JSON.stringify(result.warnings)}` : "",
          );
        }
        decision = result.output;
      } catch (e) {
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        lastError = e instanceof Error ? e.message : String(e);
        console.error(
          `brain.act LLM call failed after ${Date.now() - startedAt}ms (${ctxData.unit.model}, attempt ${attempt + 1}):`,
          detail,
        );
        // A truncated response is a property of the request, not bad luck: an
        // identical retry truncates identically and just burns the budget.
        if (NoOutputGeneratedError.isInstance(e)) {
          console.error("brain.act: no output generated — not retrying an identical request");
          break;
        }
        continue; // retry; falls through to the safe default after MAX_LLM_RETRIES
      }

      try {
        const engineAction = toEngineAction(decision, ctxData);
        await ctx.runMutation(internal.matches.applyTurn, {
          matchId,
          unitId: ctxData.unit._id,
          moveTo: decision.moveTo ?? undefined,
          action: engineAction,
          message: decision.message ?? undefined,
          thinking: decision.thinking,
        });
        return { status: "ok" as const };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        if (isStaleTurnError(reason)) {
          return { status: "skipped" as const, reason: "turn already taken" };
        }
        messages.push(
          { role: "assistant", content: JSON.stringify(decision) },
          {
            role: "user",
            content: `Your decision was rejected: ${reason}. Choose a different, legal move/action.`,
          },
        );
      }
    }

    // Safe default so a confused model can't stall the match. Surface the
    // failure reason so players can tell "model error" from "chose to wait".
    // The retries can easily outlive the turn, so this call has to tolerate a
    // match that moved on or ended underneath us just like the loop above does.
    try {
      await ctx.runMutation(internal.matches.applyTurn, {
        matchId,
        unitId: ctxData.unit._id,
        action: { kind: "wait" },
        thinking: `(brain error — holding position. ${lastError.slice(0, 300)})`,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (isStaleTurnError(reason)) {
        return { status: "skipped" as const, reason: "turn already taken" };
      }
      throw e;
    }
    return { status: "ok" as const, reason: "defaulted to wait" };
  }
}
