// The brain's scaffolding, not its model call. What is tested here is the retry
// loop: the difference between "a confused model wastes a turn" and "the match
// hangs forever".

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { NoOutputGeneratedError } from "ai";
import {
  chebyshev,
  hasLineOfSight,
  losBlockedCells,
  reachableCells,
  resolveStats,
} from "../../shared/engine";
import { matches, players, turns, units } from "../../shared/schema";
import { CATALOG_MAP, toEngineUnit, toSnapshot } from "./mappers";
import {
  act,
  assignUnitSymbols,
  attackPositions,
  buildPrompt,
  formatAttackPositions,
  type Decision,
  type DecisionGenerator,
  DecisionSchema,
  MESSAGE_MAX_CHARS,
  THINKING_MAX_CHARS,
  isStaleTurnError,
  readTurnContext,
  renderMap,
  takeTurn,
  toEngineAction,
  turnContext,
  unauthedTurnContext,
} from "./brain";
import {
  currentUnit,
  freshDb,
  getMatch,
  type Harness,
  seedMatch,
  type SeededMatch,
} from "./testing";

let h: Harness;
let seeded: SeededMatch;

beforeEach(() => {
  h = freshDb();
  seeded = seedMatch(h.db);
});
afterEach(() => h.cleanup());

function ownerOf(unitId: string): string {
  const unit = h.db.select().from(units).where(eq(units._id, unitId)).get()!;
  return h.db.select().from(players).where(eq(players._id, unit.playerId)).get()!.userId;
}

const decide = (over: Partial<Decision> = {}): Decision => ({
  thinking: "thinking",
  moveTo: null,
  action: { kind: "wait" },
  message: null,
  ...over,
});

test("readTurnContext gates on the unit's owner", () => {
  const actor = currentUnit(h.db, seeded.matchId);
  const owner = ownerOf(actor._id);
  const other = owner === seeded.userA ? seeded.userB : seeded.userA;

  expect(readTurnContext(h.db, seeded.matchId, owner)!.unit._id).toBe(actor._id);
  expect(readTurnContext(h.db, seeded.matchId, other)).toBeNull();
  // The dev bypass skips the check on purpose — it is the one auth bypass.
  expect(unauthedTurnContext(h.db, seeded.matchId)!.unit._id).toBe(actor._id);
  expect(turnContext(h.db, seeded.matchId, null)).toBeNull();
});

test("readTurnContext returns null once the match is finished", () => {
  h.db
    .update(matches)
    .set({ status: "finished", currentUnitId: null })
    .where(eq(matches._id, seeded.matchId))
    .run();
  expect(unauthedTurnContext(h.db, seeded.matchId)).toBeNull();
});

test("buildPrompt describes the board the unit can actually see", () => {
  const ctxData = unauthedTurnContext(h.db, seeded.matchId)!;
  const { system, user } = buildPrompt(ctxData);
  expect(system).toContain(ctxData.unit.name);
  expect(system).toContain(ctxData.unit.personality);
  expect(system).toContain("The grid is 12x12");
  expect(user).toContain("REACHABLE CELLS");
  expect(user).toContain(`ROUND 1 of ${ctxData.match.turnCap}`);
  // Enemies are described by name, which is what `toEngineAction` maps back.
  for (const enemy of ctxData.units.filter((u) => u.team !== ctxData.unit.team)) {
    expect(user).toContain(enemy.name);
  }
});

test("toEngineAction resolves unit names to ids and rejects unknown ones", () => {
  const ctxData = unauthedTurnContext(h.db, seeded.matchId)!;
  const enemy = ctxData.units.find((u) => u.team !== ctxData.unit.team)!;

  expect(
    toEngineAction(decide({ action: { kind: "attack", targetUnitName: enemy.name } }), ctxData),
  ).toEqual({ kind: "attack", targetUnitId: enemy._id });
  // Case-insensitive, as in Convex.
  expect(
    toEngineAction(
      decide({ action: { kind: "attack", targetUnitName: enemy.name.toUpperCase() } }),
      ctxData,
    ),
  ).toEqual({ kind: "attack", targetUnitId: enemy._id });

  expect(() =>
    toEngineAction(decide({ action: { kind: "attack", targetUnitName: "Nobody" } }), ctxData),
  ).toThrow('No unit named "Nobody"');
  expect(() =>
    toEngineAction(decide({ action: { kind: "consumable", consumableSlug: null } }), ctxData),
  ).toThrow("consumableSlug is required");
});

test("isStaleTurnError only matches the two racing-with-the-match errors", () => {
  expect(isStaleTurnError("Not this unit's turn")).toBe(true);
  expect(isStaleTurnError("Match is not running")).toBe(true);
  expect(isStaleTurnError("Illegal action: out of range")).toBe(false);
});

test("a legal decision applies the turn on the first attempt", async () => {
  const ctxData = unauthedTurnContext(h.db, seeded.matchId)!;
  let calls = 0;
  const generate: DecisionGenerator = async () => {
    calls++;
    return { decision: decide({ thinking: "steady" }), finishReason: "stop" };
  };

  expect(await takeTurn(h.db, seeded.matchId, "key", ctxData, generate)).toEqual({ status: "ok" });
  expect(calls).toBe(1);
  expect(h.db.select().from(turns).all()).toHaveLength(1);
  expect(getMatch(h.db, seeded.matchId).turnNumber).toBe(1);
});

test("a rejected decision is retried with the reason fed back to the model", async () => {
  const ctxData = unauthedTurnContext(h.db, seeded.matchId)!;
  const seen: Array<Array<{ role: string; content: string }>> = [];
  const generate: DecisionGenerator = async ({ messages }) => {
    seen.push(messages.map((m) => ({ ...m })));
    return {
      decision:
        seen.length === 1
          ? decide({ action: { kind: "attack", targetUnitName: "Nobody" } })
          : decide(),
      finishReason: "stop",
    };
  };

  expect(await takeTurn(h.db, seeded.matchId, "key", ctxData, generate)).toEqual({ status: "ok" });
  expect(seen).toHaveLength(2);
  // The second call sees the original prompt, the model's own JSON, and why it
  // was rejected. Dropping any of the three is how a model loops on one mistake.
  expect(seen[1]).toHaveLength(3);
  expect(seen[1][1].role).toBe("assistant");
  expect(seen[1][2].content).toContain('No unit named "Nobody"');
  expect(seen[1][2].content).toContain("Choose a different, legal move/action");
});

test("after the retries are spent the unit waits, with the error in `thinking`", async () => {
  const ctxData = unauthedTurnContext(h.db, seeded.matchId)!;
  let calls = 0;
  const generate: DecisionGenerator = () => {
    calls++;
    throw new Error("model exploded");
  };

  expect(await takeTurn(h.db, seeded.matchId, "key", ctxData, generate)).toEqual({
    status: "ok",
    reason: "defaulted to wait",
  });
  expect(calls).toBe(3); // 1 + MAX_LLM_RETRIES
  const row = h.db.select().from(turns).all()[0];
  expect(row.action).toEqual({ kind: "wait" });
  expect(row.thinking).toContain("brain error");
  expect(row.thinking).toContain("model exploded");
  // The match still moved on: that is the whole point of the safe default.
  expect(getMatch(h.db, seeded.matchId).turnNumber).toBe(1);
});

test("a truncated response gets ONE stricter retry, then gives up", async () => {
  const ctxData = unauthedTurnContext(h.db, seeded.matchId)!;
  let calls = 0;
  const generate: DecisionGenerator = () => {
    calls++;
    throw new NoOutputGeneratedError({ message: "no output" });
  };
  await takeTurn(h.db, seeded.matchId, "key", ctxData, generate);
  // Two calls, not three: the first truncation buys a stricter request, and that
  // is the end of it. Blind retrying of an identical request stays banned.
  expect(calls).toBe(2);
  expect(h.db.select().from(turns).all()[0].action).toEqual({ kind: "wait" });
});

test("the retry after a truncated response is a stricter request, and it lands", async () => {
  const ctxData = unauthedTurnContext(h.db, seeded.matchId)!;
  const seen: Array<string> = [];
  let calls = 0;
  const generate: DecisionGenerator = async ({ messages }) => {
    calls++;
    seen.push(messages.map((m) => m.content).join("\n"));
    // First response is cut off mid-JSON: finishReason "length" -> the SDK's
    // `.output` getter throws.
    if (calls === 1) throw new NoOutputGeneratedError({ message: "no output" });
    return {
      decision: decide({ thinking: "brief", moveTo: null }),
      finishReason: "stop",
    };
  };

  expect(await takeTurn(h.db, seeded.matchId, "key", ctxData, generate)).toEqual({ status: "ok" });
  expect(calls).toBe(2);
  // The second request is genuinely different: it says why the first failed.
  expect(seen[0]).not.toContain("too long");
  expect(seen[1]).toContain("too long");
  expect(seen[1]).toContain(String(THINKING_MAX_CHARS));
  const row = h.db.select().from(turns).all()[0];
  expect(row.thinking).toBe("brief");
});

test("an over-long thinking is truncated, not rejected", () => {
  const parsed = DecisionSchema.parse({
    moveTo: null,
    action: { kind: "wait" },
    thinking: "x".repeat(THINKING_MAX_CHARS + 500),
    message: "y".repeat(MESSAGE_MAX_CHARS + 500),
  });
  expect(parsed.thinking).toHaveLength(THINKING_MAX_CHARS);
  expect(parsed.message).toHaveLength(MESSAGE_MAX_CHARS);
});

test("moveTo and action come before thinking in the schema", () => {
  // Field order is what the model emits in, so the decision is written before the
  // flavour text. Guard it: a tidy-up that reorders these regresses the bug.
  expect(Object.keys(DecisionSchema.shape)).toEqual(["moveTo", "action", "thinking", "message"]);
});

test("a turn taken underneath us is reported as skipped, not as a failure", async () => {
  const ctxData = unauthedTurnContext(h.db, seeded.matchId)!;
  const generate: DecisionGenerator = async () => {
    // Someone else (the other tab, the dev harness) played this unit while we
    // were waiting on the model.
    h.db
      .update(matches)
      .set({ currentUnitId: getMatch(h.db, seeded.matchId).initiative[1] })
      .where(eq(matches._id, seeded.matchId))
      .run();
    return { decision: decide(), finishReason: "stop" };
  };
  expect(await takeTurn(h.db, seeded.matchId, "key", ctxData, generate)).toEqual({
    status: "skipped",
    reason: "turn already taken",
  });
  expect(h.db.select().from(turns).all()).toHaveLength(0);
});

test("a match that ended underneath us is also just skipped", async () => {
  const ctxData = unauthedTurnContext(h.db, seeded.matchId)!;
  const generate: DecisionGenerator = async () => {
    h.db
      .update(matches)
      .set({ status: "finished", winnerTeam: "a" })
      .where(eq(matches._id, seeded.matchId))
      .run();
    throw new Error("model exploded"); // force the safe-default path too
  };
  expect(await takeTurn(h.db, seeded.matchId, "key", ctxData, generate)).toEqual({
    status: "skipped",
    reason: "turn already taken",
  });
});

test("act skips when it is not your unit's turn", async () => {
  const actor = currentUnit(h.db, seeded.matchId);
  const other = ownerOf(actor._id) === seeded.userA ? seeded.userB : seeded.userA;
  expect(await act(h.db, seeded.matchId, other, "key")).toEqual({
    status: "skipped",
    reason: "not your turn",
  });
});

// ── The spatial view ───────────────────────────────────────────────────────
// These three helpers are the part of the prompt the model cannot work out for
// itself, so they are tested against the engine rather than against a snapshot
// of their own output.

test("assignUnitSymbols labels the actor @, allies as digits, enemies as letters", () => {
  const ctxData = unauthedTurnContext(h.db, seeded.matchId)!;
  const snapshot = toSnapshot(ctxData.match, ctxData.units);
  const symbols = assignUnitSymbols(snapshot, ctxData.unit._id);

  expect(symbols.get(ctxData.unit._id)).toBe("@");
  for (const u of snapshot.units) {
    if (!u.alive || u.id === ctxData.unit._id) continue;
    const s = symbols.get(u.id)!;
    expect(s).toMatch(u.team === ctxData.unit.team ? /^[0-9]$/ : /^[A-H]$/);
  }
  // Deterministic: same state, same board.
  expect([...assignUnitSymbols(snapshot, ctxData.unit._id)]).toEqual([...symbols]);
});

test("renderMap draws a gridSize-square board with the actor on it", () => {
  const ctxData = unauthedTurnContext(h.db, seeded.matchId)!;
  const snapshot = toSnapshot(ctxData.match, ctxData.units);
  const symbols = assignUnitSymbols(snapshot, ctxData.unit._id);
  const board = renderMap(snapshot, symbols, []);

  const rows = board.split("\n");
  expect(rows.length).toBe(snapshot.gridSize + 1); // header + one row per y
  expect(board).toContain("@");
  // Walls are drawn where the match says they are, and nowhere else.
  const wall = snapshot.walls[0];
  if (wall) {
    const cells = rows[wall.y + 1].trim().split(/\s+/).slice(1);
    expect(cells[wall.x]).toBe("#");
  }
});

test("attackPositions only lists cells with a real shot, and flags exposure", () => {
  const ctxData = unauthedTurnContext(h.db, seeded.matchId)!;
  const snapshot = toSnapshot(ctxData.match, ctxData.units);
  const me = toEngineUnit(ctxData.unit);
  const stats = resolveStats(me.loadout, CATALOG_MAP);
  const symbols = assignUnitSymbols(snapshot, me.id);
  const reachable = reachableCells(me.position, 20, snapshot, {
    crossesWalls: stats.crossesWalls,
  });
  const shots = attackPositions(snapshot, me, stats, reachable, CATALOG_MAP, symbols);

  const blocked = losBlockedCells(snapshot);
  const enemies = snapshot.units.filter((u) => u.alive && u.team !== me.team);
  for (const shot of shots) {
    expect(shot.targets.length).toBeGreaterThan(0);
    for (const name of shot.targets) {
      const target = enemies.find((e) => e.name === name)!;
      expect(chebyshev(shot.cell, target.position)).toBeLessThanOrEqual(stats.attackRange);
      if (stats.needsLos) {
        expect(hasLineOfSight(shot.cell, target.position, blocked)).toBe(true);
      }
    }
  }

  const text = formatAttackPositions(shots);
  if (shots.length === 0) {
    expect(text).toContain("none");
  } else {
    expect(text).toMatch(/\[(safe|under fire from )/);
  }
});
