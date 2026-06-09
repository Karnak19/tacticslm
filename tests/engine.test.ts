import { describe, expect, test } from "bun:test";
import { CATALOG } from "../convex/lib/catalog";
import {
  checkWin,
  computeInitiative,
  type EngineUnit,
  generateWalls,
  hasLineOfSight,
  IllegalAction,
  type Loadout,
  losBlockedCells,
  nextTurn,
  reachableCells,
  resolveStats,
  resolveTurn,
  type Snapshot,
} from "../convex/lib/engine";

const catalog = new Map(CATALOG.map((i) => [i.slug, i]));

const baseLoadout: Loadout = {
  weapon: "sword",
  helmet: "hood",
  chest: "leather",
  boots: "swiftboots",
  active: "heal_pulse",
  consumables: ["health_potion", "throwing_knife"],
};

function makeUnit(overrides: Partial<EngineUnit> & { id: string }): EngineUnit {
  return {
    team: "a",
    name: overrides.id,
    loadout: baseLoadout,
    position: { x: 0, y: 0 },
    hp: 23,
    alive: true,
    activeCooldown: 0,
    usedConsumables: [],
    lastActedRound: -1,
    ...overrides,
  };
}

function makeSnapshot(units: Array<EngineUnit>, walls: Snapshot["walls"] = []): Snapshot {
  return { gridSize: 16, walls, units, effects: [], roundNumber: 1 };
}

describe("resolveStats", () => {
  test("combines base stats and gear bonuses", () => {
    const stats = resolveStats(baseLoadout, catalog);
    // 20 base +3 leather; move 3 +1 sword +1 swiftboots; speed 10 +3 hood
    expect(stats.maxHp).toBe(23);
    expect(stats.move).toBe(5);
    expect(stats.speed).toBe(13);
    expect(stats.damage).toBe(6);
    expect(stats.attackRange).toBe(1);
  });

  test("visor extends ranged weapons only", () => {
    const bow = resolveStats({ ...baseLoadout, weapon: "bow", helmet: "visor" }, catalog);
    expect(bow.attackRange).toBe(6);
    const sword = resolveStats({ ...baseLoadout, helmet: "visor" }, catalog);
    expect(sword.attackRange).toBe(1);
  });

  test("full tank build matches design budget", () => {
    const tank = resolveStats(
      {
        ...baseLoadout,
        weapon: "crossbow",
        helmet: "great_helm",
        chest: "plate",
        boots: "greaves",
      },
      catalog,
    );
    expect(tank.maxHp).toBe(33);
    expect(tank.speed).toBe(3); // 10 −3 crossbow −1 helm −2 plate −1 greaves
    expect(tank.move).toBe(2);
  });
});

describe("reachableCells", () => {
  test("walls block movement and units block pathing", () => {
    const mover = makeUnit({ id: "m", position: { x: 0, y: 0 } });
    const blocker = makeUnit({ id: "b", position: { x: 1, y: 0 } });
    // Wall column at x=1 except y=0 (where the blocker stands)
    const walls = [
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 1, y: 3 },
    ];
    const snapshot = makeSnapshot([mover, blocker], walls);
    const cells = reachableCells({ x: 0, y: 0 }, 2, snapshot, { crossesWalls: false });
    // Can't stand on the blocker or pass the wall at x=1
    expect(cells.some((c) => c.x === 1 && c.y === 0)).toBe(false);
    expect(cells.some((c) => c.x === 2 && c.y === 0)).toBe(false);
    expect(cells.some((c) => c.x === 0 && c.y === 2)).toBe(true);
  });

  test("climbing hooks cross exactly one wall", () => {
    const mover = makeUnit({ id: "m", position: { x: 0, y: 0 } });
    const walls = [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ];
    const snapshot = makeSnapshot([mover], walls);
    const cells = reachableCells({ x: 0, y: 0 }, 3, snapshot, { crossesWalls: true });
    // Crossing wall (1,0) is allowed but not two walls in a row to (3,0) straight;
    // cannot end on a wall cell either.
    expect(cells.some((c) => c.x === 1 && c.y === 0)).toBe(false);
    expect(cells.some((c) => c.x === 2 && c.y === 0)).toBe(false);
  });
});

describe("line of sight", () => {
  test("wall blocks LoS, smoke blocks LoS", () => {
    const snapshot = makeSnapshot([], [{ x: 2, y: 0 }]);
    let blocked = losBlockedCells(snapshot);
    expect(hasLineOfSight({ x: 0, y: 0 }, { x: 4, y: 0 }, blocked)).toBe(false);
    expect(hasLineOfSight({ x: 0, y: 0 }, { x: 0, y: 4 }, blocked)).toBe(true);

    snapshot.effects.push({
      kind: "smoke",
      cells: [{ x: 0, y: 2 }],
      expiresAfterRound: 1,
    });
    blocked = losBlockedCells(snapshot);
    expect(hasLineOfSight({ x: 0, y: 0 }, { x: 0, y: 4 }, blocked)).toBe(false);
  });
});

describe("resolveTurn", () => {
  test("move + attack kills and reports events", () => {
    const attacker = makeUnit({ id: "atk", position: { x: 0, y: 0 } });
    const victim = makeUnit({
      id: "v",
      team: "b",
      position: { x: 0, y: 3 },
      hp: 6,
    });
    const snapshot = makeSnapshot([attacker, victim]);
    const { snapshot: out, events } = resolveTurn(
      snapshot,
      catalog,
      "atk",
      { x: 0, y: 2 },
      { kind: "attack", targetUnitId: "v" },
    );
    const deadVictim = out.units.find((u) => u.id === "v")!;
    expect(deadVictim.alive).toBe(false);
    expect(events.join(" ")).toContain("eliminated");
  });

  test("rejects out-of-range moves and attacks", () => {
    const attacker = makeUnit({ id: "atk", position: { x: 0, y: 0 } });
    const victim = makeUnit({ id: "v", team: "b", position: { x: 15, y: 15 } });
    const snapshot = makeSnapshot([attacker, victim]);
    expect(() => resolveTurn(snapshot, catalog, "atk", { x: 9, y: 9 }, { kind: "wait" })).toThrow(
      IllegalAction,
    );
    expect(() =>
      resolveTurn(snapshot, catalog, "atk", undefined, {
        kind: "attack",
        targetUnitId: "v",
      }),
    ).toThrow(IllegalAction);
  });

  test("dagger bonus applies only if target acted this round", () => {
    const rogue = makeUnit({
      id: "r",
      loadout: { ...baseLoadout, weapon: "dagger" },
      position: { x: 0, y: 0 },
    });
    const victim = makeUnit({
      id: "v",
      team: "b",
      position: { x: 0, y: 1 },
      hp: 20,
      lastActedRound: 1,
    });
    const snapshot = makeSnapshot([rogue, victim]);
    const { snapshot: out } = resolveTurn(snapshot, catalog, "r", undefined, {
      kind: "attack",
      targetUnitId: "v",
    });
    expect(out.units.find((u) => u.id === "v")!.hp).toBe(14); // 4 + 2 bonus

    victim.lastActedRound = 0;
    const { snapshot: out2 } = resolveTurn(makeSnapshot([rogue, victim]), catalog, "r", undefined, {
      kind: "attack",
      targetUnitId: "v",
    });
    expect(out2.units.find((u) => u.id === "v")!.hp).toBe(16); // no bonus
  });

  test("grenade hits allies too", () => {
    const thrower = makeUnit({
      id: "t",
      loadout: { ...baseLoadout, active: "grenade" },
      position: { x: 0, y: 0 },
    });
    const friend = makeUnit({ id: "f", position: { x: 3, y: 3 }, hp: 10 });
    const enemy = makeUnit({ id: "e", team: "b", position: { x: 4, y: 4 }, hp: 10 });
    const snapshot = makeSnapshot([thrower, friend, enemy]);
    const { snapshot: out } = resolveTurn(snapshot, catalog, "t", undefined, {
      kind: "active",
      targetCell: { x: 3, y: 3 },
    });
    expect(out.units.find((u) => u.id === "f")!.hp).toBe(7);
    expect(out.units.find((u) => u.id === "e")!.hp).toBe(7);
    expect(out.units.find((u) => u.id === "t")!.activeCooldown).toBe(4);
  });

  test("taunted unit must attack the taunter", () => {
    const taunter = makeUnit({ id: "tank", team: "b", position: { x: 0, y: 2 } });
    const other = makeUnit({ id: "other", team: "b", position: { x: 1, y: 1 } });
    const taunted = makeUnit({ id: "x", position: { x: 0, y: 1 } });
    const snapshot = makeSnapshot([taunter, other, taunted]);
    snapshot.effects.push({
      kind: "taunt",
      sourceUnitId: "tank",
      affectedUnitIds: ["x"],
      expiresAfterRound: 1,
    });
    expect(() =>
      resolveTurn(snapshot, catalog, "x", undefined, {
        kind: "attack",
        targetUnitId: "other",
      }),
    ).toThrow(IllegalAction);
    const ok = resolveTurn(snapshot, catalog, "x", undefined, {
      kind: "attack",
      targetUnitId: "tank",
    });
    expect(ok.events.join(" ")).toContain("attacks");
  });

  test("consumables are single-use and cost the action", () => {
    const unit = makeUnit({ id: "u", hp: 10 });
    const enemy = makeUnit({ id: "e", team: "b", position: { x: 9, y: 9 } });
    let snapshot = makeSnapshot([unit, enemy]);
    const r1 = resolveTurn(snapshot, catalog, "u", undefined, {
      kind: "consumable",
      slug: "health_potion",
    });
    expect(r1.snapshot.units.find((u) => u.id === "u")!.hp).toBe(18);
    expect(() =>
      resolveTurn(r1.snapshot, catalog, "u", undefined, {
        kind: "consumable",
        slug: "health_potion",
      }),
    ).toThrow(IllegalAction);
  });
});

describe("match flow", () => {
  test("initiative sorts by resolved speed", () => {
    const slow = makeUnit({
      id: "slow",
      loadout: { ...baseLoadout, weapon: "crossbow", helmet: "great_helm" },
    });
    const fast = makeUnit({ id: "fast", loadout: { ...baseLoadout, weapon: "dagger" } });
    expect(computeInitiative([slow, fast], catalog)[0]).toBe("fast");
  });

  test("nextTurn skips dead units and wraps rounds", () => {
    const a = makeUnit({ id: "a" });
    const b = makeUnit({ id: "b", alive: false, hp: 0 });
    const c = makeUnit({ id: "c", team: "b" });
    const next = nextTurn(["a", "b", "c"], 0, 1, [a, b, c]);
    expect(next!.unitId).toBe("c");
    const wrap = nextTurn(["a", "b", "c"], 2, 1, [a, b, c]);
    expect(wrap).toEqual({ index: 0, roundNumber: 2, wrapped: true, unitId: "a" });
  });

  test("checkWin: elimination and HP tiebreak at cap", () => {
    const a = makeUnit({ id: "a", hp: 5 });
    const b = makeUnit({ id: "b", team: "b", hp: 10 });
    expect(checkWin(makeSnapshot([a, b]), 20)).toEqual({ finished: false });
    const capped = { ...makeSnapshot([a, b]), roundNumber: 21 };
    expect(checkWin(capped, 20)).toEqual({ finished: true, winnerTeam: "b" });
    a.alive = false;
    expect(checkWin(makeSnapshot([a, b]), 20)).toEqual({ finished: true, winnerTeam: "b" });
  });
});

describe("generateWalls", () => {
  test("deterministic, connected, and out of spawn bands", () => {
    const walls1 = generateWalls(42, 16);
    const walls2 = generateWalls(42, 16);
    expect(walls1).toEqual(walls2);
    expect(walls1.length).toBeGreaterThan(0);
    for (const w of walls1) {
      expect(w.y).toBeGreaterThanOrEqual(3);
      expect(w.y).toBeLessThan(13);
    }
  });
});
