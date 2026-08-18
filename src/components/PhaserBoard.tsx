import { useEffect, useRef, useState } from "react";
import Phaser from "phaser";
import type { Doc } from "../../convex/_generated/dataModel";
import { CATALOG, type CatalogItem } from "../../convex/lib/catalog";
import { resolveStats } from "../../convex/lib/engine";
import { skinTier } from "../lib/sprites";
import { BoardScene, type BoardUnit, type Popup } from "../game/BoardScene";

// The item catalog is static data, so max HP can be resolved client-side
// without another query.
const catalog: Map<string, CatalogItem> = new Map(CATALOG.map((i) => [i.slug, i]));

function maxHpOf(unit: Doc<"units">): number {
  try {
    return resolveStats(unit.loadout, catalog).maxHp;
  } catch {
    return Math.max(1, unit.hp ?? 1);
  }
}

// Ranged attackers arc a projectile; melee strikes in place.
function isRanged(unit: Doc<"units"> | undefined): boolean {
  if (!unit) return false;
  try {
    return resolveStats(unit.loadout, catalog).attackRange > 1;
  } catch {
    return false;
  }
}

export default function PhaserBoard({
  match,
  units,
  smokeCells,
  lastTurn,
  popups,
}: {
  match: Doc<"matches">;
  units: Array<Doc<"units">>;
  smokeCells: Array<{ x: number; y: number }>;
  lastTurn?: Doc<"turns">;
  popups: Array<Popup>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const sceneRef = useRef<BoardScene | null>(null);
  const booted = useRef(false); // StrictMode double-mount guard
  const consumed = useRef(0); // highest popup id already floated
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (booted.current || !hostRef.current) return;
    booted.current = true;
    const scene = new BoardScene(() => setReady(true));
    sceneRef.current = scene;
    gameRef.current = new Phaser.Game({
      type: Phaser.AUTO,
      parent: hostRef.current,
      transparent: true,
      pixelArt: true,
      roundPixels: true,
      scale: { mode: Phaser.Scale.RESIZE, width: "100%", height: "100%" },
      scene: [scene],
    });
    return () => {
      gameRef.current?.destroy(true);
      gameRef.current = null;
      sceneRef.current = null;
      booted.current = false;
      setReady(false);
    };
  }, []);

  // Terrain and smoke: the scene ignores these when nothing actually changed.
  useEffect(() => {
    if (!ready) return;
    sceneRef.current?.setTerrain(match.gridSize, match.walls);
  }, [ready, match.gridSize, match.walls]);

  useEffect(() => {
    if (!ready) return;
    sceneRef.current?.setSmoke(smokeCells);
  }, [ready, smokeCells]);

  // Unit snapshot + any fresh HP popups; the scene diffs against its registry.
  useEffect(() => {
    if (!ready) return;
    const alive: Array<BoardUnit> = units
      .filter((u) => u.position && u.alive)
      .map((u) => ({
        id: u._id,
        team: u.team,
        name: u.name,
        tier: skinTier(u.skin, u.loadout.weapon),
        position: u.position!,
        hp: u.hp ?? 0,
        maxHp: maxHpOf(u),
      }));
    const fresh = popups.filter((p) => p.id > consumed.current);
    if (fresh.length > 0) consumed.current = fresh[fresh.length - 1].id;
    sceneRef.current?.sync(alive, match.currentUnitId, fresh);
  }, [ready, units, match.currentUnitId, popups]);

  // Attack / kill flourishes, keyed on the turn id so each turn plays once.
  useEffect(() => {
    if (!ready || !lastTurn) return;
    const actor = units.find((u) => u._id === lastTurn.unitId);
    const targetId = lastTurn.action.kind === "attack" ? lastTurn.action.targetUnitId : undefined;
    const target = targetId ? units.find((u) => u._id === targetId) : undefined;
    sceneRef.current?.playTurn({
      id: lastTurn._id,
      actorCell: actor?.position,
      targetCell: target?.position,
      ranged: isRanged(actor),
      killed: target ? target.alive === false : false,
    });
  }, [ready, lastTurn, units]);

  return (
    <div
      ref={hostRef}
      className="aspect-square w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900"
    />
  );
}
