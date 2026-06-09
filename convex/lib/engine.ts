// Deterministic game engine — pure functions, no Convex dependencies.
// Mutations build a Snapshot from the DB, call into here, and persist the result.

import { BASE_STATS, type CatalogItem } from "./catalog";

export type Position = { x: number; y: number };
export type Team = "a" | "b";

export type Loadout = {
  weapon: string;
  helmet: string;
  chest: string;
  boots: string;
  active: string;
  consumables: Array<string>;
};

export type EngineUnit = {
  id: string;
  team: Team;
  name: string;
  loadout: Loadout;
  position: Position;
  hp: number;
  alive: boolean;
  activeCooldown: number;
  usedConsumables: Array<string>;
  lastActedRound: number;
};

export type Effect =
  | { kind: "smoke"; cells: Array<Position>; expiresAfterRound: number }
  | {
      kind: "taunt";
      sourceUnitId: string;
      affectedUnitIds: Array<string>;
      expiresAfterRound: number;
    }
  | { kind: "adrenaline"; unitId: string; expiresAfterRound: number }
  | { kind: "cloak_spent"; unitId: string; expiresAfterRound: number };

export type Snapshot = {
  gridSize: number;
  walls: Array<Position>;
  units: Array<EngineUnit>;
  effects: Array<Effect>;
  roundNumber: number;
};

export type Action =
  | { kind: "attack"; targetUnitId: string }
  | { kind: "active"; targetCell?: Position; targetUnitId?: string }
  | { kind: "consumable"; slug: string; targetCell?: Position; targetUnitId?: string }
  | { kind: "wait" };

export type ResolvedStats = {
  maxHp: number;
  move: number;
  speed: number;
  damage: number;
  attackRange: number;
  needsLos: boolean;
  crossesWalls: boolean;
  messageBudgetMultiplier: number;
};

export type Catalog = Map<string, CatalogItem>;

const sameCell = (a: Position, b: Position) => a.x === b.x && a.y === b.y;
const key = (p: Position) => `${p.x},${p.y}`;

export function chebyshev(a: Position, b: Position): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

// ---------------------------------------------------------------------------
// Stats

export function resolveStats(loadout: Loadout, catalog: Catalog): ResolvedStats {
  const gear = [loadout.weapon, loadout.helmet, loadout.chest, loadout.boots].map((slug) => {
    const item = catalog.get(slug);
    if (!item) throw new Error(`Unknown item: ${slug}`);
    return item;
  });
  const weapon = gear[0];

  let maxHp = BASE_STATS.hp;
  let move = BASE_STATS.move;
  let speed = BASE_STATS.speed;
  for (const item of gear) {
    maxHp += item.stats.hpBonus ?? 0;
    move += item.stats.moveBonus ?? 0;
    speed += item.stats.speedBonus ?? 0;
  }

  let attackRange = weapon.stats.range ?? 1;
  // Visor: +1 attack range, ranged weapons only (those needing line of sight).
  if (loadout.helmet === "visor" && weapon.flags.needsLos) {
    attackRange += 1;
  }

  return {
    maxHp,
    move: Math.max(1, move),
    speed,
    damage: weapon.stats.damage ?? 0,
    attackRange,
    needsLos: weapon.flags.needsLos ?? false,
    crossesWalls: loadout.boots === "climbing_hooks",
    messageBudgetMultiplier: loadout.helmet === "strategists_circlet" ? 2 : 1,
  };
}

// Effective move for this turn, including adrenaline (engine adds dash separately).
export function effectiveMove(
  unit: EngineUnit,
  stats: ResolvedStats,
  effects: Array<Effect>,
): number {
  const adrenaline = effects.some((e) => e.kind === "adrenaline" && e.unitId === unit.id);
  return stats.move + (adrenaline ? 2 : 0);
}

export function effectiveSpeed(
  unit: EngineUnit,
  stats: ResolvedStats,
  effects: Array<Effect>,
): number {
  const adrenaline = effects.some((e) => e.kind === "adrenaline" && e.unitId === unit.id);
  return stats.speed + (adrenaline ? 4 : 0);
}

// ---------------------------------------------------------------------------
// Grid generation — seeded so a match's map is reproducible from its seed.

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Teams spawn on opposite edges: team a on y=0..1, team b on y=gridSize-2..gridSize-1.
export function spawnRows(gridSize: number): { a: Array<number>; b: Array<number> } {
  return { a: [0, 1], b: [gridSize - 2, gridSize - 1] };
}

export function generateWalls(seed: number, gridSize: number): Array<Position> {
  const rng = mulberry32(seed);
  for (let attempt = 0; attempt < 50; attempt++) {
    const walls = new Set<string>();
    const clusterCount = 8 + Math.floor(rng() * 4);
    for (let c = 0; c < clusterCount; c++) {
      // Clusters stay out of the two spawn bands.
      const cx = 1 + Math.floor(rng() * (gridSize - 2));
      const cy = 3 + Math.floor(rng() * (gridSize - 6));
      const len = 2 + Math.floor(rng() * 3);
      const horizontal = rng() < 0.5;
      for (let i = 0; i < len; i++) {
        const x = horizontal ? cx + i : cx;
        const y = horizontal ? cy : cy + i;
        if (x >= 0 && x < gridSize && y >= 3 && y < gridSize - 3) {
          walls.add(`${x},${y}`);
        }
      }
    }
    const wallList = [...walls].map((s) => {
      const [x, y] = s.split(",").map(Number);
      return { x, y };
    });
    if (isFullyConnected(wallList, gridSize)) return wallList;
  }
  // Practically unreachable: scattered short clusters almost never seal the map.
  return [];
}

function isFullyConnected(walls: Array<Position>, gridSize: number): boolean {
  const blocked = new Set(walls.map(key));
  const total = gridSize * gridSize - walls.length;
  const start = { x: 0, y: 0 };
  if (blocked.has(key(start))) return false;
  const seen = new Set([key(start)]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const [dx, dy] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ] as const) {
      const next = { x: cur.x + dx, y: cur.y + dy };
      const k = key(next);
      if (
        next.x < 0 ||
        next.x >= gridSize ||
        next.y < 0 ||
        next.y >= gridSize ||
        blocked.has(k) ||
        seen.has(k)
      ) {
        continue;
      }
      seen.add(k);
      queue.push(next);
    }
  }
  return seen.size === total;
}

// ---------------------------------------------------------------------------
// Movement — BFS with a wall-crossing budget (climbing hooks).
// Units block pathing and cannot be ended on; wall cells can be crossed with
// the budget but never ended on.

export function reachableCells(
  from: Position,
  moveBudget: number,
  snapshot: Snapshot,
  options: { crossesWalls: boolean },
): Array<Position> {
  const wallSet = new Set(snapshot.walls.map(key));
  const occupied = new Set(
    snapshot.units
      .filter((u) => u.alive && !sameCell(u.position, from))
      .map((u) => key(u.position)),
  );
  const maxWallCrossings = options.crossesWalls ? 1 : 0;

  // best wall-crossings used to reach a cell at a given distance
  const visited = new Map<string, number>();
  visited.set(key(from), 0);
  let frontier: Array<{ pos: Position; wallsUsed: number }> = [{ pos: from, wallsUsed: 0 }];
  const result: Array<Position> = [];

  for (let step = 1; step <= moveBudget && frontier.length; step++) {
    const next: typeof frontier = [];
    for (const { pos, wallsUsed } of frontier) {
      for (const [dx, dy] of [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
      ] as const) {
        const cell = { x: pos.x + dx, y: pos.y + dy };
        if (
          cell.x < 0 ||
          cell.x >= snapshot.gridSize ||
          cell.y < 0 ||
          cell.y >= snapshot.gridSize
        ) {
          continue;
        }
        const k = key(cell);
        const isWall = wallSet.has(k);
        const cost = isWall ? wallsUsed + 1 : wallsUsed;
        if (cost > maxWallCrossings) continue;
        if (occupied.has(k)) continue;
        const prev = visited.get(k);
        if (prev !== undefined && prev <= cost) continue;
        visited.set(k, cost);
        next.push({ pos: cell, wallsUsed: cost });
        if (!isWall) result.push(cell);
      }
    }
    frontier = next;
  }
  // Dedupe (a cell can be reached twice with different wall budgets).
  const seen = new Set<string>();
  return result.filter((p) => {
    const k = key(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Line of sight — supercover line; blocked by walls and smoke.

export function losBlockedCells(snapshot: Snapshot): Set<string> {
  const blocked = new Set(snapshot.walls.map(key));
  for (const e of snapshot.effects) {
    if (e.kind === "smoke" && e.expiresAfterRound >= snapshot.roundNumber) {
      for (const c of e.cells) blocked.add(key(c));
    }
  }
  return blocked;
}

export function hasLineOfSight(from: Position, to: Position, blocked: Set<string>): boolean {
  // Sample the segment finely; endpoints don't block their own line.
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) * 2;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const cell = {
      x: Math.round(from.x + (to.x - from.x) * t),
      y: Math.round(from.y + (to.y - from.y) * t),
    };
    if (sameCell(cell, from) || sameCell(cell, to)) continue;
    if (blocked.has(key(cell))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Action resolution. Validates against the snapshot, returns the mutated
// snapshot plus human-readable event strings (the turn summary / replay text).

export type Resolution = {
  snapshot: Snapshot;
  events: Array<string>;
};

export class IllegalAction extends Error {}

function getUnit(snapshot: Snapshot, id: string): EngineUnit {
  const unit = snapshot.units.find((u) => u.id === id);
  if (!unit) throw new IllegalAction(`No such unit: ${id}`);
  return unit;
}

function activeEffects(snapshot: Snapshot): Array<Effect> {
  return snapshot.effects.filter((e) => e.expiresAfterRound >= snapshot.roundNumber);
}

function cellsInArea(center: Position, area: number, gridSize: number): Array<Position> {
  const radius = Math.floor(area / 2);
  const cells: Array<Position> = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      const c = { x: center.x + dx, y: center.y + dy };
      if (c.x >= 0 && c.x < gridSize && c.y >= 0 && c.y < gridSize) cells.push(c);
    }
  }
  return cells;
}

function applyDamage(
  snapshot: Snapshot,
  target: EngineUnit,
  rawDamage: number,
  events: Array<string>,
): void {
  let damage = rawDamage;
  // Cloak: first attack each round deals −1 while not adjacent to an enemy.
  if (target.loadout.chest === "cloak") {
    const spent = snapshot.effects.some(
      (e) =>
        e.kind === "cloak_spent" &&
        e.unitId === target.id &&
        e.expiresAfterRound >= snapshot.roundNumber,
    );
    const adjacentEnemy = snapshot.units.some(
      (u) => u.alive && u.team !== target.team && chebyshev(u.position, target.position) === 1,
    );
    if (!spent && !adjacentEnemy) {
      damage = Math.max(0, damage - 1);
      snapshot.effects.push({
        kind: "cloak_spent",
        unitId: target.id,
        expiresAfterRound: snapshot.roundNumber,
      });
    }
  }
  target.hp -= damage;
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    events.push(`${target.name} is eliminated!`);
  }
}

export function resolveTurn(
  input: Snapshot,
  catalog: Catalog,
  unitId: string,
  moveTo: Position | undefined,
  action: Action,
): Resolution {
  // Work on a deep copy; callers persist the returned snapshot.
  const snapshot: Snapshot = structuredClone(input);
  const events: Array<string> = [];
  const unit = getUnit(snapshot, unitId);
  if (!unit.alive) throw new IllegalAction("Unit is dead");
  const stats = resolveStats(unit.loadout, catalog);
  const effects = activeEffects(snapshot);

  // --- Movement (optional, before the action) ---
  let moveBudget = effectiveMove(unit, stats, effects);
  const isDash = action.kind === "active" && unit.loadout.active === "dash";
  if (isDash) {
    if (unit.activeCooldown > 0) throw new IllegalAction("Dash is on cooldown");
    const dash = catalog.get("dash")!;
    moveBudget += dash.stats.moveBonus ?? 0;
    unit.activeCooldown = dash.stats.cooldown ?? 0;
    events.push(`${unit.name} dashes!`);
  }
  if (moveTo && !sameCell(moveTo, unit.position)) {
    const reachable = reachableCells(unit.position, moveBudget, snapshot, {
      crossesWalls: stats.crossesWalls,
    });
    if (!reachable.some((c) => sameCell(c, moveTo))) {
      throw new IllegalAction(`Cell (${moveTo.x},${moveTo.y}) is not reachable`);
    }
    unit.position = { ...moveTo };
    events.push(`${unit.name} moves to (${moveTo.x},${moveTo.y}).`);
  }

  // --- Action ---
  switch (action.kind) {
    case "wait": {
      events.push(`${unit.name} holds position.`);
      break;
    }

    case "attack": {
      const target = getUnit(snapshot, action.targetUnitId);
      if (!target.alive) throw new IllegalAction("Target is already dead");
      if (target.team === unit.team) throw new IllegalAction("Cannot attack a teammate");

      // Taunt: if this unit is taunted, it may only attack the taunter.
      const taunt = effects.find((e) => e.kind === "taunt" && e.affectedUnitIds.includes(unit.id));
      if (taunt && taunt.kind === "taunt" && taunt.sourceUnitId !== target.id) {
        const taunter = getUnit(snapshot, taunt.sourceUnitId);
        if (taunter.alive) {
          throw new IllegalAction(`Taunted: must attack ${taunter.name} or not attack`);
        }
      }

      const dist = chebyshev(unit.position, target.position);
      if (dist > stats.attackRange) throw new IllegalAction("Target out of range");
      if (stats.needsLos) {
        const blocked = losBlockedCells(snapshot);
        if (!hasLineOfSight(unit.position, target.position, blocked)) {
          throw new IllegalAction("No line of sight to target");
        }
      }

      let damage = stats.damage;
      if (unit.loadout.weapon === "dagger" && target.lastActedRound === snapshot.roundNumber) {
        damage += 2;
        events.push(`${unit.name} strikes after ${target.name}'s move: +2 damage.`);
      }
      events.push(`${unit.name} attacks ${target.name} for ${damage} damage.`);
      applyDamage(snapshot, target, damage, events);
      break;
    }

    case "active": {
      if (isDash) break; // dash already applied during movement
      if (unit.activeCooldown > 0) throw new IllegalAction("Active is on cooldown");
      const item = catalog.get(unit.loadout.active);
      if (!item || item.slot !== "active") {
        throw new IllegalAction(`Invalid active: ${unit.loadout.active}`);
      }
      resolveAbility(snapshot, catalog, unit, item, action, stats, events);
      unit.activeCooldown = item.stats.cooldown ?? 0;
      break;
    }

    case "consumable": {
      if (!unit.loadout.consumables.includes(action.slug)) {
        throw new IllegalAction(`Not in loadout: ${action.slug}`);
      }
      if (unit.usedConsumables.includes(action.slug)) {
        throw new IllegalAction(`Already used: ${action.slug}`);
      }
      const item = catalog.get(action.slug);
      if (!item || item.slot !== "consumable") {
        throw new IllegalAction(`Invalid consumable: ${action.slug}`);
      }
      resolveConsumable(snapshot, unit, item, action, stats, events);
      unit.usedConsumables.push(action.slug);
      break;
    }
  }

  unit.lastActedRound = snapshot.roundNumber;
  return { snapshot, events };
}

function resolveAbility(
  snapshot: Snapshot,
  catalog: Catalog,
  unit: EngineUnit,
  item: CatalogItem,
  action: { targetCell?: Position; targetUnitId?: string },
  stats: ResolvedStats,
  events: Array<string>,
): void {
  switch (item.slug) {
    case "heal_pulse": {
      const target = action.targetUnitId ? getUnit(snapshot, action.targetUnitId) : unit;
      if (!target.alive) throw new IllegalAction("Target is dead");
      if (target.team !== unit.team) throw new IllegalAction("Can only heal teammates");
      const range = item.stats.range ?? 0;
      if (chebyshev(unit.position, target.position) > range) {
        throw new IllegalAction("Heal target out of range");
      }
      const maxHp = resolveStats(target.loadout, catalog).maxHp;
      const healed = Math.min(item.stats.heal ?? 0, maxHp - target.hp);
      target.hp += healed;
      events.push(`${unit.name} heals ${target.name} for ${healed} HP.`);
      break;
    }
    case "smoke_bomb": {
      if (!action.targetCell) throw new IllegalAction("Smoke bomb needs a target cell");
      if (chebyshev(unit.position, action.targetCell) > (item.stats.range ?? 0)) {
        throw new IllegalAction("Smoke target out of range");
      }
      const cells = cellsInArea(action.targetCell, item.stats.area ?? 3, snapshot.gridSize);
      snapshot.effects.push({
        kind: "smoke",
        cells,
        expiresAfterRound: snapshot.roundNumber + (item.stats.duration ?? 1),
      });
      events.push(
        `${unit.name} throws a smoke bomb at (${action.targetCell.x},${action.targetCell.y}).`,
      );
      break;
    }
    case "taunt": {
      const range = item.stats.range ?? 0;
      const affected = snapshot.units
        .filter(
          (u) => u.alive && u.team !== unit.team && chebyshev(u.position, unit.position) <= range,
        )
        .map((u) => u.id);
      snapshot.effects.push({
        kind: "taunt",
        sourceUnitId: unit.id,
        affectedUnitIds: affected,
        expiresAfterRound: snapshot.roundNumber + (item.stats.duration ?? 1),
      });
      events.push(
        `${unit.name} taunts ${affected.length} enem${affected.length === 1 ? "y" : "ies"}.`,
      );
      break;
    }
    case "grenade": {
      if (!action.targetCell) throw new IllegalAction("Grenade needs a target cell");
      if (chebyshev(unit.position, action.targetCell) > (item.stats.range ?? 0)) {
        throw new IllegalAction("Grenade target out of range");
      }
      const cells = cellsInArea(action.targetCell, item.stats.area ?? 3, snapshot.gridSize);
      events.push(
        `${unit.name} throws a grenade at (${action.targetCell.x},${action.targetCell.y})!`,
      );
      for (const victim of snapshot.units) {
        if (!victim.alive) continue;
        if (!cells.some((c) => sameCell(c, victim.position))) continue;
        // Friendly fire is ON — allies and self included.
        events.push(`${victim.name} is caught in the blast for ${item.stats.damage} damage.`);
        applyDamage(snapshot, victim, item.stats.damage ?? 0, events);
      }
      break;
    }
    default:
      throw new IllegalAction(`Unhandled active: ${item.slug}`);
  }
  void stats;
}

function resolveConsumable(
  snapshot: Snapshot,
  unit: EngineUnit,
  item: CatalogItem,
  action: { targetCell?: Position; targetUnitId?: string },
  stats: ResolvedStats,
  events: Array<string>,
): void {
  switch (item.slug) {
    case "health_potion": {
      const healed = Math.min(item.stats.heal ?? 0, stats.maxHp - unit.hp);
      unit.hp += healed;
      events.push(`${unit.name} drinks a health potion (+${healed} HP).`);
      break;
    }
    case "adrenaline": {
      snapshot.effects.push({
        kind: "adrenaline",
        unitId: unit.id,
        expiresAfterRound: snapshot.roundNumber + (item.stats.duration ?? 2) - 1,
      });
      events.push(`${unit.name} injects adrenaline (+2 move, +4 speed).`);
      break;
    }
    case "throwing_knife": {
      const target = action.targetUnitId ? getUnit(snapshot, action.targetUnitId) : undefined;
      if (!target || !target.alive) throw new IllegalAction("Throwing knife needs a living target");
      if (target.team === unit.team) throw new IllegalAction("Cannot hit a teammate");
      if (chebyshev(unit.position, target.position) > (item.stats.range ?? 0)) {
        throw new IllegalAction("Throwing knife target out of range");
      }
      // Lobbed: no line of sight needed.
      events.push(
        `${unit.name} hurls a throwing knife at ${target.name} for ${item.stats.damage} damage.`,
      );
      applyDamage(snapshot, target, item.stats.damage ?? 0, events);
      break;
    }
    case "antidote": {
      snapshot.effects = snapshot.effects.filter(
        (e) => !(e.kind === "taunt" && e.affectedUnitIds.includes(unit.id)),
      );
      events.push(`${unit.name} drinks an antidote.`);
      break;
    }
    default:
      throw new IllegalAction(`Unhandled consumable: ${item.slug}`);
  }
}

// ---------------------------------------------------------------------------
// Turn order & win conditions

export function computeInitiative(units: Array<EngineUnit>, catalog: Catalog): Array<string> {
  return [...units]
    .map((u) => ({ id: u.id, speed: resolveStats(u.loadout, catalog).speed }))
    .sort((a, b) => b.speed - a.speed)
    .map((u) => u.id);
}

export type WinCheck = { finished: false } | { finished: true; winnerTeam: Team | "draw" };

export function checkWin(snapshot: Snapshot, turnCapRounds: number): WinCheck {
  const aliveA = snapshot.units.filter((u) => u.alive && u.team === "a");
  const aliveB = snapshot.units.filter((u) => u.alive && u.team === "b");
  if (aliveA.length === 0 && aliveB.length === 0) {
    return { finished: true, winnerTeam: "draw" };
  }
  if (aliveA.length === 0) return { finished: true, winnerTeam: "b" };
  if (aliveB.length === 0) return { finished: true, winnerTeam: "a" };
  if (snapshot.roundNumber > turnCapRounds) {
    const hpA = aliveA.reduce((s, u) => s + u.hp, 0);
    const hpB = aliveB.reduce((s, u) => s + u.hp, 0);
    if (hpA === hpB) return { finished: true, winnerTeam: "draw" };
    return { finished: true, winnerTeam: hpA > hpB ? "a" : "b" };
  }
  return { finished: false };
}

// Advance to the next living unit. Returns the new index/round and whether the
// round wrapped (callers decrement cooldowns on wrap).
export function nextTurn(
  initiative: Array<string>,
  currentIndex: number,
  roundNumber: number,
  units: Array<EngineUnit>,
): { index: number; roundNumber: number; wrapped: boolean; unitId: string } | null {
  const aliveIds = new Set(units.filter((u) => u.alive).map((u) => u.id));
  if (aliveIds.size === 0) return null;
  let index = currentIndex;
  let round = roundNumber;
  let wrapped = false;
  for (let i = 0; i < initiative.length; i++) {
    index += 1;
    if (index >= initiative.length) {
      index = 0;
      round += 1;
      wrapped = true;
    }
    if (aliveIds.has(initiative[index])) {
      return { index, roundNumber: round, wrapped, unitId: initiative[index] };
    }
  }
  return null;
}
