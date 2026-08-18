// The game-rules regression net. This is the one place where a silent change to
// `applyTurn` shows up as a failing test rather than a weird match three weeks
// from now.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { matches, messages, players, rooms, turns, units, users } from "../../shared/schema";
import type { Effect } from "../../shared/engine";
import { applyTurn, byRoom, forfeit, replay, teamMessages } from "./matches";
import { CATALOG_MAP, toEngineUnit } from "./mappers";
import { resolveStats } from "../../shared/engine";
import {
  currentUnit,
  freshDb,
  getMatch,
  getUnit,
  getUser,
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

/** Take a legal `wait` for whoever is on the clock. */
async function waitTurn(): Promise<void> {
  const unit = currentUnit(h.db, seeded.matchId);
  await applyTurn(h.db, { matchId: seeded.matchId, unitId: unit._id, action: { kind: "wait" } });
}

describe("applyTurn", () => {
  test("a legal wait records a turn row and advances initiative", async () => {
    const before = getMatch(h.db, seeded.matchId);
    const actor = currentUnit(h.db, seeded.matchId);

    await applyTurn(h.db, {
      matchId: seeded.matchId,
      unitId: actor._id,
      action: { kind: "wait" },
      thinking: "holding the line",
    });

    const after = getMatch(h.db, seeded.matchId);
    expect(after.turnNumber).toBe(before.turnNumber + 1);
    expect(after.initiativeIndex).toBe(1);
    expect(after.currentUnitId).toBe(before.initiative[1]);

    const rows = h.db.select().from(turns).where(eq(turns.matchId, seeded.matchId)).all();
    expect(rows).toHaveLength(1);
    // Stamped with the PRE-advance turn number: the replay is indexed by the turn
    // the action belonged to, not the one it produced.
    expect(rows[0].turnNumber).toBe(before.turnNumber);
    expect(rows[0].unitId).toBe(actor._id);
    expect(rows[0].thinking).toBe("holding the line");
  });

  test("moving to an unreachable cell is rejected and writes nothing", async () => {
    const actor = currentUnit(h.db, seeded.matchId);
    await expect(
      applyTurn(h.db, {
        matchId: seeded.matchId,
        unitId: actor._id,
        moveTo: { x: 11, y: 11 },
        action: { kind: "wait" },
      }),
    ).rejects.toThrow(/Illegal action/);

    expect(h.db.select().from(turns).all()).toHaveLength(0);
    expect(getMatch(h.db, seeded.matchId).turnNumber).toBe(0);
    expect(getUnit(h.db, actor._id).position).toEqual(actor.position);
  });

  test("acting out of turn is rejected as a stale turn", async () => {
    const match = getMatch(h.db, seeded.matchId);
    const notCurrent = match.initiative[1];
    await expect(
      applyTurn(h.db, { matchId: seeded.matchId, unitId: notCurrent, action: { kind: "wait" } }),
    ).rejects.toThrow("Not this unit's turn");
  });

  test("attacking out of range is rejected", async () => {
    const actor = currentUnit(h.db, seeded.matchId);
    const enemy = h.db
      .select()
      .from(units)
      .where(and(eq(units.roomId, seeded.roomId), eq(units.team, actor.team === "a" ? "b" : "a")))
      .get()!;
    await expect(
      applyTurn(h.db, {
        matchId: seeded.matchId,
        unitId: actor._id,
        action: { kind: "attack", targetUnitId: enemy._id },
      }),
    ).rejects.toThrow(/Illegal action/);
  });

  test("a full pass through initiative wraps the round", async () => {
    const size = getMatch(h.db, seeded.matchId).initiative.length;
    for (let i = 0; i < size; i++) await waitTurn();
    const match = getMatch(h.db, seeded.matchId);
    expect(match.roundNumber).toBe(2);
    expect(match.initiativeIndex).toBe(0);
    expect(match.turnNumber).toBe(size);
  });

  test("cooldowns tick down exactly once per round wrap", async () => {
    const match = getMatch(h.db, seeded.matchId);
    // Two rounds of cooldown on a living unit; it should read 1 after one wrap.
    const target = match.initiative[1];
    h.db.update(units).set({ activeCooldown: 2 }).where(eq(units._id, target)).run();

    for (let i = 0; i < match.initiative.length; i++) await waitTurn();
    expect(getUnit(h.db, target).activeCooldown).toBe(1);

    for (let i = 0; i < match.initiative.length; i++) await waitTurn();
    expect(getUnit(h.db, target).activeCooldown).toBe(0);

    // And it does not go negative on the next wrap.
    for (let i = 0; i < match.initiative.length; i++) await waitTurn();
    expect(getUnit(h.db, target).activeCooldown).toBe(0);
  });

  test("effects expire on the wrap that passes their round", async () => {
    const match = getMatch(h.db, seeded.matchId);
    const stale: Effect = { kind: "smoke", cells: [{ x: 0, y: 0 }], expiresAfterRound: 1 };
    const lasting: Effect = { kind: "smoke", cells: [{ x: 1, y: 1 }], expiresAfterRound: 5 };
    h.db
      .update(matches)
      .set({ effects: [stale, lasting] })
      .where(eq(matches._id, seeded.matchId))
      .run();

    for (let i = 0; i < match.initiative.length; i++) await waitTurn();
    const effects = getMatch(h.db, seeded.matchId).effects;
    expect(effects).toHaveLength(1);
    expect(effects[0].expiresAfterRound).toBe(5);
  });

  test("eliminating the last enemy finishes the match and the room", async () => {
    const actor = currentUnit(h.db, seeded.matchId);
    const enemyTeam = actor.team === "a" ? "b" : "a";
    const enemies = h.db
      .select()
      .from(units)
      .where(and(eq(units.roomId, seeded.roomId), eq(units.team, enemyTeam)))
      .all();
    // Kill every enemy but one, and put the survivor next to us on 1 HP.
    for (const enemy of enemies.slice(1)) {
      h.db.update(units).set({ hp: 0, alive: false }).where(eq(units._id, enemy._id)).run();
    }
    const survivor = enemies[0];
    h.db
      .update(units)
      .set({ hp: 1, alive: true, position: { x: actor.position!.x, y: actor.position!.y + 1 } })
      .where(eq(units._id, survivor._id))
      .run();

    await applyTurn(h.db, {
      matchId: seeded.matchId,
      unitId: actor._id,
      action: { kind: "attack", targetUnitId: survivor._id },
    });

    const match = getMatch(h.db, seeded.matchId);
    expect(match.status).toBe("finished");
    expect(match.winnerTeam).toBe(actor.team);
    // No unit is on the clock once the match is over.
    expect(match.currentUnitId).toBeNull();
    expect(h.db.select().from(rooms).where(eq(rooms._id, seeded.roomId)).get()!.status).toBe(
      "finished",
    );
    // The turn that ended it is still in the replay.
    expect(h.db.select().from(turns).all()).toHaveLength(1);
  });

  test("the round cap ends the match on total HP", async () => {
    const match = getMatch(h.db, seeded.matchId);
    // Sit one wrap away from the cap, with team a ahead on HP.
    h.db
      .update(matches)
      .set({ roundNumber: match.turnCap })
      .where(eq(matches._id, seeded.matchId))
      .run();
    h.db.update(units).set({ hp: 1 }).where(eq(units.team, "b")).run();

    for (let i = 0; i < match.initiative.length; i++) {
      if (getMatch(h.db, seeded.matchId).status === "finished") break;
      await waitTurn();
    }

    const finished = getMatch(h.db, seeded.matchId);
    expect(finished.status).toBe("finished");
    expect(finished.roundNumber).toBe(match.turnCap + 1);
    expect(finished.winnerTeam).toBe("a");
    expect(finished.currentUnitId).toBeNull();
  });

  test("a turn on a finished match is rejected", async () => {
    h.db
      .update(matches)
      .set({ status: "finished", winnerTeam: "a" })
      .where(eq(matches._id, seeded.matchId))
      .run();
    await expect(
      applyTurn(h.db, {
        matchId: seeded.matchId,
        unitId: getMatch(h.db, seeded.matchId).initiative[0],
        action: { kind: "wait" },
      }),
    ).rejects.toThrow("Match is not running");
  });
});

describe("team chat budget", () => {
  test("a message is clamped to the unit's server-side budget", async () => {
    const actor = currentUnit(h.db, seeded.matchId);
    const stats = resolveStats(toEngineUnit(actor).loadout, CATALOG_MAP);
    const budget = 200 * stats.messageBudgetMultiplier;

    await applyTurn(h.db, {
      matchId: seeded.matchId,
      unitId: actor._id,
      action: { kind: "wait" },
      message: "x".repeat(budget + 500),
    });

    const row = h.db.select().from(messages).all()[0];
    expect(row.text).toHaveLength(budget);
    expect(row.team).toBe(actor.team);
    // Stamped with the pre-advance turn number, like the turn row.
    expect(row.turnNumber).toBe(0);
  });

  test("a blank message inserts nothing", async () => {
    const actor = currentUnit(h.db, seeded.matchId);
    await applyTurn(h.db, {
      matchId: seeded.matchId,
      unitId: actor._id,
      action: { kind: "wait" },
      message: "   ",
    });
    expect(h.db.select().from(messages).all()).toHaveLength(0);
  });
});

// ── The concurrency guarantee Convex used to give us for free ───────────────
describe("concurrent applyTurn", () => {
  test("two calls for the same turn: exactly one wins, the other is stale", async () => {
    const actor = currentUnit(h.db, seeded.matchId);
    const args = {
      matchId: seeded.matchId,
      unitId: actor._id,
      action: { kind: "wait" as const },
    };

    const results = await Promise.allSettled([applyTurn(h.db, args), applyTurn(h.db, args)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(reason.message).toBe("Not this unit's turn");

    // One turn applied, not two: no double-spend, no double initiative tick.
    expect(h.db.select().from(turns).all()).toHaveLength(1);
    expect(getMatch(h.db, seeded.matchId).turnNumber).toBe(1);
    expect(getMatch(h.db, seeded.matchId).initiativeIndex).toBe(1);
  });

  test("the whole initiative fired out of order: only the unit on the clock lands", async () => {
    const match = getMatch(h.db, seeded.matchId);
    // Reverse order, so every call but the last one queued is out of turn.
    const results = await Promise.allSettled(
      [...match.initiative]
        .reverse()
        .map((unitId) =>
          applyTurn(h.db, { matchId: seeded.matchId, unitId, action: { kind: "wait" } }),
        ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(h.db.select().from(turns).all()).toHaveLength(1);
  });

  test("the whole initiative fired at once in order serialises cleanly", async () => {
    const match = getMatch(h.db, seeded.matchId);
    // Each call becomes legal exactly when the one before it commits, so all six
    // land — but strictly one at a time. Interleaving would show up as duplicate
    // turn numbers or a skipped one.
    await Promise.all(
      match.initiative.map((unitId) =>
        applyTurn(h.db, { matchId: seeded.matchId, unitId, action: { kind: "wait" } }),
      ),
    );
    const rows = h.db.select().from(turns).all();
    expect(rows.map((r) => r.turnNumber).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rows.map((r) => r.unitId)).toEqual(match.initiative);
    expect(getMatch(h.db, seeded.matchId).roundNumber).toBe(2);
  });
});

// ── Secrecy: one team's plans must never reach the other ────────────────────
describe("teamMessages / replay secrecy", () => {
  async function speak(team: "a" | "b", text: string): Promise<void> {
    // Walk initiative until it is this team's turn, then have them talk.
    for (let i = 0; i < 12; i++) {
      const unit = currentUnit(h.db, seeded.matchId);
      await applyTurn(h.db, {
        matchId: seeded.matchId,
        unitId: unit._id,
        action: { kind: "wait" },
        message: unit.team === team ? text : undefined,
      });
      if (unit.team === team) return;
    }
    throw new Error(`team ${team} never got a turn`);
  }

  test("a player sees only their own team's chat mid-match", async () => {
    await speak("a", "team a plan");
    await speak("b", "team b plan");

    const alice = getUser(h.db, seeded.userA);
    const bob = getUser(h.db, seeded.userB);

    const aliceSees = teamMessages(h.db, alice, seeded.matchId);
    expect(aliceSees.map((m) => m.text)).toEqual(["team a plan"]);
    expect(aliceSees.every((m) => m.team === "a")).toBe(true);

    const bobSees = teamMessages(h.db, bob, seeded.matchId);
    expect(bobSees.map((m) => m.text)).toEqual(["team b plan"]);
    expect(bobSees.some((m) => m.team === "a")).toBe(false);
  });

  test("a non-player and an anonymous caller see nothing", async () => {
    await speak("a", "team a plan");
    const [outsider] = h.db
      .insert(users)
      .values({ clerkId: "clerk_outsider", name: "Nosy" })
      .returning()
      .all();
    expect(teamMessages(h.db, outsider, seeded.matchId)).toEqual([]);
    expect(teamMessages(h.db, null, seeded.matchId)).toEqual([]);
  });

  test("replay withholds messages until the match is finished", async () => {
    await speak("a", "team a plan");
    await speak("b", "team b plan");

    const running = replay(h.db, seeded.matchId)!;
    expect(running.match.status).toBe("running");
    expect(running.messages).toEqual([]);
    expect(running.turns.length).toBeGreaterThan(0);

    const alice = getUser(h.db, seeded.userA);
    await forfeit(h.db, alice, seeded.matchId);

    const finished = replay(h.db, seeded.matchId)!;
    expect(finished.match.status).toBe("finished");
    expect(finished.messages.map((m) => m.text).sort()).toEqual(["team a plan", "team b plan"]);
  });

  test("replay carries each unit's reasoning while the match is still running", async () => {
    // Deliberate: reasoning is the spectacle, and it is not a secret. No unit's
    // prompt reads another unit's thinking (readTurnContext feeds each model only
    // its own team's chat), and a human cannot act on it because applyTurn is
    // reachable only from the brain. Team chat is the thing that stays gated —
    // asserted in the test above.
    const unit = currentUnit(h.db, seeded.matchId)!;
    await applyTurn(h.db, {
      matchId: seeded.matchId,
      unitId: unit._id,
      action: { kind: "wait" },
      thinking: "flank left, then focus their sniper",
    });

    const running = replay(h.db, seeded.matchId)!;
    expect(running.match.status).toBe("running");
    expect(running.turns.some((t) => t.thinking === "flank left, then focus their sniper")).toBe(
      true,
    );
    // ...while chat from the same turn is still withheld.
    expect(running.messages).toEqual([]);
  });
});

describe("forfeit", () => {
  test("conceding hands the win to the other team and ends the room", async () => {
    const alice = getUser(h.db, seeded.userA);
    await forfeit(h.db, alice, seeded.matchId);

    const match = getMatch(h.db, seeded.matchId);
    expect(match.status).toBe("finished");
    expect(match.winnerTeam).toBe("b");
    expect(match.currentUnitId).toBeNull();
    expect(h.db.select().from(rooms).where(eq(rooms._id, seeded.roomId)).get()!.status).toBe(
      "finished",
    );
  });

  test("a non-player cannot forfeit someone else's match", async () => {
    const [outsider] = h.db
      .insert(users)
      .values({ clerkId: "clerk_outsider2", name: "Nosy" })
      .returning()
      .all();
    await expect(forfeit(h.db, outsider, seeded.matchId)).rejects.toThrow(
      "Not a player in this room",
    );
    expect(getMatch(h.db, seeded.matchId).status).toBe("running");
  });

  test("an anonymous caller cannot forfeit", async () => {
    await expect(forfeit(h.db, null, seeded.matchId)).rejects.toThrow("Not authenticated");
  });

  test("forfeiting twice is rejected", async () => {
    const alice = getUser(h.db, seeded.userA);
    await forfeit(h.db, alice, seeded.matchId);
    await expect(forfeit(h.db, alice, seeded.matchId)).rejects.toThrow("Match is not running");
  });
});

describe("byRoom", () => {
  test("returns the live match and every unit in the room", () => {
    const state = byRoom(h.db, seeded.roomId)!;
    expect(state.match._id).toBe(seeded.matchId);
    expect(state.units).toHaveLength(6);
    // Every unit is spawned: position/hp/alive are set, not null.
    expect(state.units.every((u) => u.position !== null && u.alive === true)).toBe(true);
  });

  test("returns null for a room with no match", () => {
    const [room] = h.db.insert(rooms).values({ code: "EMPTYY", status: "lobby" }).returning().all();
    expect(byRoom(h.db, room._id)).toBeNull();
  });
});

describe("players fixture sanity", () => {
  test("the two commanders are on opposite teams", () => {
    const roster = h.db.select().from(players).where(eq(players.roomId, seeded.roomId)).all();
    expect(roster.map((p) => p.team).sort()).toEqual(["a", "b"]);
  });
});
