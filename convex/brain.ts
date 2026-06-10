// The brain-runner: the only way a unit takes a turn.
// PokerLM-style — the client passes its OpenRouter key per call; the key only
// transits through this action and is never stored. The prompt is built
// server-side from a consistent snapshot, and the result is applied via an
// internal mutation, so players cannot hand-craft actions.

import { v } from "convex/values";
import { z } from "zod";
import { generateText, Output } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { action, internalQuery } from "./_generated/server";
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
import type { CatalogItem } from "./lib/catalog";
import { currentUser } from "./lib/auth";

const BASE_MESSAGE_BUDGET = 200;
const MAX_LLM_RETRIES = 2;

// Everything the action needs, read in one consistent snapshot.
export const turnContext = internalQuery({
  args: { matchId: v.id("matches") },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (!user) return null;
    const match = await ctx.db.get(args.matchId);
    if (!match || match.status !== "running" || !match.currentUnitId) return null;
    const unit = await ctx.db.get(match.currentUnitId);
    if (!unit) return null;
    const player = await ctx.db.get(unit.playerId);
    if (!player || player.userId !== user._id) return null; // not your unit's turn

    const units = await ctx.db
      .query("units")
      .withIndex("by_room", (q) => q.eq("roomId", match.roomId))
      .collect();
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_match_and_team", (q) => q.eq("matchId", args.matchId).eq("team", unit.team))
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
  },
});

type TurnContext = {
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

function buildPrompt(ctxData: TurnContext): { system: string; user: string } {
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

  const allies = units.filter((u) => u.team === unit.team && u._id !== unit._id);
  const enemies = units.filter((u) => u.team !== unit.team);
  const describeUnit = (u: (typeof units)[number]) => {
    const eu = toEngineUnit(u);
    if (!eu.alive) return `- ${u.name}: DEAD`;
    const dist = chebyshev(me.position, eu.position);
    const los = hasLineOfSight(me.position, eu.position, blocked);
    return `- ${u.name} at (${eu.position.x},${eu.position.y}), HP ${eu.hp}, distance ${dist}${los ? "" : ", NO line of sight"}`;
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
- The grid is ${match.gridSize}x${match.gridSize}; (0,0) is top-left. Cells listed as walls are impassable.
- On your turn you may MOVE (optional) and then take ONE action: attack, active ability, consumable, or wait.
- Only pick moveTo from your REACHABLE CELLS list.
- Attacks need the target within your weapon range${stats.needsLos ? " and line of sight" : ""}.
- Your message to teammates is limited to ${BASE_MESSAGE_BUDGET * stats.messageBudgetMultiplier} characters.
- If your action is illegal it will be rejected and you will be asked again; repeated failures waste your turn.
- Your decision fields must match your thinking: if you plan to move, SET moveTo. A null moveTo means you stand still.
- The match ends at the round cap: the team with more total HP wins. If you cannot attack this turn, ADVANCE toward the enemy — waiting in safety is how you lose on points.`;

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

WALLS: ${match.walls.map((w) => `(${w.x},${w.y})`).join(" ")}

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

export const act = action({
  args: { matchId: v.id("matches"), apiKey: v.string() },
  returns: v.object({
    status: v.union(v.literal("ok"), v.literal("skipped"), v.literal("error")),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const ctxData = await ctx.runQuery(internal.brain.turnContext, {
      matchId: args.matchId,
    });
    if (!ctxData) return { status: "skipped" as const, reason: "not your turn" };

    // OpenRouter app attribution: https://openrouter.ai/docs/app-attribution
    const openrouter = createOpenRouter({
      apiKey: args.apiKey,
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

    for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt++) {
      let decision: z.infer<typeof DecisionSchema>;
      const startedAt = Date.now();
      try {
        // No client-side timeout: Convex caps actions at 10 minutes, and
        // aborting mid-response was causing spurious failures.
        const result = await generateText({
          model: openrouter.chat(ctxData.unit.model, {
            reasoning: { effort: "low", exclude: true },
          }),
          output: Output.object({ schema: DecisionSchema }),
          system,
          messages,
          temperature: 0.7,
        });
        decision = result.output;
      } catch (e) {
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        lastError = e instanceof Error ? e.message : String(e);
        console.error(
          `brain.act LLM call failed after ${Date.now() - startedAt}ms (${ctxData.unit.model}, attempt ${attempt + 1}):`,
          detail,
        );
        continue; // retry; falls through to the safe default after MAX_LLM_RETRIES
      }

      try {
        const engineAction = toEngineAction(decision, ctxData);
        await ctx.runMutation(internal.matches.applyTurn, {
          matchId: args.matchId,
          unitId: ctxData.unit._id,
          moveTo: decision.moveTo ?? undefined,
          action: engineAction,
          message: decision.message ?? undefined,
          thinking: decision.thinking,
        });
        return { status: "ok" as const };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        if (reason.includes("Not this unit's turn") || reason.includes("not running")) {
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
    await ctx.runMutation(internal.matches.applyTurn, {
      matchId: args.matchId,
      unitId: ctxData.unit._id,
      action: { kind: "wait" },
      thinking: `(brain error — holding position. ${lastError.slice(0, 300)})`,
    });
    return { status: "ok" as const, reason: "defaulted to wait" };
  },
});
