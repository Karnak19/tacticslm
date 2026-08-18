// The board renderer. Knows nothing about React or Convex: callers push
// snapshots in through setTerrain / setSmoke / sync / playTurn, and the scene
// diffs them against its own registry of game objects.

import Phaser from "phaser";
import {
  CHARACTER_ANIMS,
  CHARACTER_FRAME,
  CHARACTER_TIERS,
  type CharacterAnim,
  type CharacterTier,
  FACINGS,
  type Facing,
  TERRAIN_SHEET,
  WALL_FRAME,
  characterSheet,
  floorFrame,
} from "../lib/sprites";

export type Cell = { x: number; y: number };

export type BoardUnit = {
  id: string;
  team: "a" | "b";
  name: string;
  /** Which of the three character sprites to use — from `skinTier()`. */
  tier: CharacterTier;
  position: Cell;
  hp: number;
  maxHp: number;
};

/** One HP change to float above a unit. */
export type Popup = { id: number; cell: Cell; delta: number };

/** What just happened, for the attack/kill flourishes. */
export type TurnFx = {
  id: string;
  actorCell?: Cell;
  targetCell?: Cell;
  /** Arc a projectile instead of striking in place. */
  ranged: boolean;
  killed: boolean;
};

const TEAM_COLOR = { a: 0x0ea5e9, b: 0xf43f5e } as const;
const AMBER = 0xfbbf24;

/** Team a spawns on the top rows, team b on the bottom (convex/lib/engine.ts). */
const TEAM_FACING: Record<"a" | "b", Facing> = { a: "down", b: "up" };

/**
 * Inside a 64px frame the character stands between y=20 and y=47 — measured off
 * the sheets. So the frame's bottom edge sits FOOT_INSET art-pixels below the
 * feet, and that gap has to be subtracted to plant a unit on its cell.
 */
const FOOT_INSET = 17;
/** Art-pixel height of the character itself, used to size it against a cell. */
const BODY_HEIGHT = 27;

const MOVE_MS = 420;

type UnitView = {
  container: Phaser.GameObjects.Container;
  bg: Phaser.GameObjects.Rectangle;
  ring: Phaser.GameObjects.Rectangle;
  ringTween?: Phaser.Tweens.Tween;
  sprite: Phaser.GameObjects.Sprite;
  hpBg: Phaser.GameObjects.Rectangle;
  hpFill: Phaser.GameObjects.Rectangle;
  cell: Cell;
  hp: number;
  maxHp: number;
  team: "a" | "b";
  tier: CharacterTier;
  /** No facing exists on the server, so the scene remembers what it inferred. */
  facing: Facing;
  /** Playing its death animation: nothing may put it back on its feet. */
  dead: boolean;
};

function animKey(tier: CharacterTier, anim: CharacterAnim, facing: Facing) {
  return `sw${tier}-${anim}-${facing}`;
}

/** Facing from a step: the dominant axis of the delta, or undefined if it stood still. */
function facingFor(from: Cell, to: Cell): Facing | undefined {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return undefined;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

export class BoardScene extends Phaser.Scene {
  private onReady: () => void;

  private gridSize = 12;
  private cellSize = 32;
  private originX = 0;
  private originY = 0;

  // Rebuild guards: terrain and smoke only get torn down when they change.
  private terrainKey = "";
  private smokeKey = "";
  private terrain: Array<Phaser.GameObjects.Image> = [];
  private grid?: Phaser.GameObjects.Graphics;
  private smoke: Array<{ cell: Cell; rect: Phaser.GameObjects.Rectangle }> = [];

  private views = new Map<string, UnitView>();
  // Units playing their death animation: off the registry, still on screen, so
  // the killing blow's fx still has something to hit.
  private dying: Array<UnitView> = [];
  private currentUnitId?: string;
  private lastTurnId = "";

  constructor(onReady: () => void) {
    super("board");
    this.onReady = onReady;
  }

  preload() {
    if (!this.textures.exists(TERRAIN_SHEET.key)) {
      this.load.spritesheet(TERRAIN_SHEET.key, TERRAIN_SHEET.url, {
        frameWidth: TERRAIN_SHEET.tile,
        frameHeight: TERRAIN_SHEET.tile,
      });
    }
    for (const tier of CHARACTER_TIERS) {
      for (const anim of CHARACTER_ANIMS) {
        const sheet = characterSheet(tier, anim);
        if (this.textures.exists(sheet.key)) continue;
        this.load.spritesheet(sheet.key, sheet.url, {
          frameWidth: CHARACTER_FRAME,
          frameHeight: CHARACTER_FRAME,
        });
      }
    }
  }

  create() {
    const g = this.add.graphics();
    g.fillStyle(0xffffff, 1).fillCircle(3, 3, 3);
    g.generateTexture("spark", 6, 6);
    g.destroy();

    this.registerAnims();
    this.grid = this.add.graphics().setDepth(1);

    this.measure(this.scale.width, this.scale.height);
    this.drawGrid();
    this.scale.on(Phaser.Scale.Events.RESIZE, (size: Phaser.Structs.Size) => {
      this.resize(size.width, size.height);
    });
    this.onReady();
  }

  // -------------------------------------------------------------------------
  // Animations — one per tier, animation and facing. Sheets are four rows of
  // facings, N frames wide, so a row's frames are a contiguous index range.

  private registerAnims() {
    for (const tier of CHARACTER_TIERS) {
      for (const anim of CHARACTER_ANIMS) {
        const sheet = characterSheet(tier, anim);
        FACINGS.forEach((facing, row) => {
          const key = animKey(tier, anim, facing);
          if (this.anims.exists(key)) return;
          const start = row * sheet.frames;
          this.anims.create({
            key,
            frames: this.anims.generateFrameNumbers(sheet.key, {
              start,
              end: start + sheet.framesFor(facing) - 1,
            }),
            frameRate: sheet.fps,
            // Idle and walk loop; a strike and a death each play once.
            repeat: anim === "idle" || anim === "walk" ? -1 : 0,
          });
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Layout — everything is derived from cellSize, nothing is a pixel constant.

  private measure(width: number, height: number) {
    const side = Math.max(1, Math.min(width, height));
    // Snap the cell to a whole number of source tiles: a fractional cell means
    // a fractional texture scale, which makes the pixel art shimmer. Whatever
    // is left over becomes margin, and the board centres in it.
    const tile = TERRAIN_SHEET.tile;
    const raw = side / this.gridSize;
    this.cellSize = Math.max(tile, Math.floor(raw / tile) * tile);
    this.originX = (width - this.cellSize * this.gridSize) / 2;
    this.originY = (height - this.cellSize * this.gridSize) / 2;
  }

  /**
   * Whole-number sprite scale, for the same no-shimmer reason: aim for a
   * character about nine tenths of a cell tall, then round.
   */
  private spriteScale() {
    return Phaser.Math.Clamp(Math.round((this.cellSize * 0.9) / BODY_HEIGHT), 1, 4);
  }

  private px(v: number) {
    return this.originX + (v + 0.5) * this.cellSize;
  }

  private py(v: number) {
    return this.originY + (v + 0.5) * this.cellSize;
  }

  resize(width: number, height: number) {
    this.measure(width, height);
    this.layoutTerrain();
    this.drawGrid();
    for (const view of this.views.values()) this.layoutUnit(view, true);
  }

  // A lattice over the floor. The CraftPix flagstones already carry their own
  // seams, so this only has to make the cells countable — hence a much fainter
  // line than the flat Kenney slab needed.
  private drawGrid() {
    const g = this.grid;
    if (!g) return;
    const span = this.cellSize * this.gridSize;
    g.clear().lineStyle(1, 0x000000, 0.1);
    for (let i = 0; i <= this.gridSize; i++) {
      const at = i * this.cellSize;
      g.lineBetween(this.originX + at, this.originY, this.originX + at, this.originY + span);
      g.lineBetween(this.originX, this.originY + at, this.originX + span, this.originY + at);
    }
  }

  private layoutTerrain() {
    const size = this.cellSize; // an exact multiple of the tile, so no seams
    for (const img of this.terrain) {
      const { x, y } = img.getData("cell") as Cell;
      img.setPosition(this.px(x), this.py(y)).setDisplaySize(size, size);
    }
    for (const { cell, rect } of this.smoke) {
      rect.setPosition(this.px(cell.x), this.py(cell.y)).setSize(size, size);
    }
  }

  // -------------------------------------------------------------------------
  // Terrain

  setTerrain(gridSize: number, walls: Array<Cell>) {
    const key = `${gridSize}|${walls
      .map((w) => `${w.x},${w.y}`)
      .sort()
      .join(";")}`;
    if (key === this.terrainKey) return;
    this.terrainKey = key;
    this.gridSize = gridSize;

    for (const img of this.terrain) img.destroy();
    this.terrain = [];

    const wallSet = new Set(walls.map((w) => `${w.x},${w.y}`));
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const isWall = wallSet.has(`${x},${y}`);
        // The floor always goes down; a wall is a solid block laid on top of it,
        // above the lattice so the grid lines don't cut across the stone.
        const floor = this.add
          .image(0, 0, TERRAIN_SHEET.key, floorFrame(x, y))
          .setDepth(0)
          .setData("cell", { x, y });
        this.terrain.push(floor);
        if (!isWall) continue;
        const wall = this.add
          .image(0, 0, TERRAIN_SHEET.key, WALL_FRAME)
          .setDepth(2)
          .setData("cell", { x, y });
        this.terrain.push(wall);
      }
    }
    this.measure(this.scale.width, this.scale.height);
    this.layoutTerrain();
    this.drawGrid();
  }

  setSmoke(cells: Array<Cell>) {
    const key = cells
      .map((c) => `${c.x},${c.y}`)
      .sort()
      .join(";");
    if (key === this.smokeKey) return;
    this.smokeKey = key;

    for (const { rect } of this.smoke) rect.destroy();
    this.smoke = cells.map((cell) => ({
      cell,
      rect: this.add.rectangle(0, 0, 1, 1, 0xd4d4d8, 0.5).setDepth(5),
    }));
    this.layoutTerrain();
  }

  // -------------------------------------------------------------------------
  // Units — the diff React's reconciler used to do for free.

  sync(units: Array<BoardUnit>, currentUnitId: string | undefined, popups: Array<Popup>) {
    this.currentUnitId = currentUnitId;
    const seen = new Set<string>();

    for (const unit of units) {
      seen.add(unit.id);
      const view = this.views.get(unit.id);
      if (!view) {
        this.createUnit(unit);
        continue;
      }
      if (view.cell.x !== unit.position.x || view.cell.y !== unit.position.y) {
        const from = view.cell;
        view.cell = { ...unit.position };
        // Facing comes from the movement delta — the server has no facing field.
        this.face(view, facingFor(from, view.cell) ?? view.facing);
        this.play(view, "walk");
        view.container.setDepth(this.unitDepth(view.cell));
        this.tweens.add({
          targets: view.container,
          x: this.px(view.cell.x),
          y: this.py(view.cell.y),
          duration: MOVE_MS,
          ease: "Back.easeOut",
          onComplete: () => this.play(view, "idle"),
        });
      }
      if (view.hp !== unit.hp || view.maxHp !== unit.maxHp) {
        view.hp = unit.hp;
        view.maxHp = unit.maxHp;
        this.tweens.add({
          targets: view.hpFill,
          displayWidth: this.hpWidth(view),
          duration: 400,
          ease: "Sine.easeOut",
        });
      }
      this.applyRing(view, unit.id === currentUnitId);
    }

    // Anything gone from the snapshot (dead, or removed) dies on screen.
    // Copy first: killUnit() mutates the registry as we go.
    for (const [id, view] of Array.from(this.views)) {
      if (seen.has(id)) continue;
      this.views.delete(id);
      this.killUnit(view);
    }

    for (const popup of popups) this.floatNumber(popup);
  }

  private hpWidth(view: UnitView) {
    const full = this.cellSize * 0.72;
    const frac = view.maxHp > 0 ? view.hp / view.maxHp : 0;
    return full * Phaser.Math.Clamp(frac, 0, 1);
  }

  private createUnit(unit: BoardUnit) {
    const bg = this.add.rectangle(0, 0, 1, 1, TEAM_COLOR[unit.team], 0.35);
    const ring = this.add.rectangle(0, 0, 1, 1, 0x000000, 0);
    ring.setStrokeStyle(2, AMBER).setVisible(false);
    // Bottom-centre origin: the sprite is taller than its cell, so it hangs
    // upward out of the cell and its feet stay planted on the floor.
    const sprite = this.add.sprite(0, 0, characterSheet(unit.tier, "idle").key).setOrigin(0.5, 1);
    const hpBg = this.add.rectangle(0, 0, 1, 1, 0x09090b, 0.8);
    const hpFill = this.add.rectangle(0, 0, 1, 1, 0x34d399, 1).setOrigin(0, 0.5);

    const container = this.add
      .container(this.px(unit.position.x), this.py(unit.position.y), [
        bg,
        ring,
        sprite,
        hpBg,
        hpFill,
      ])
      .setDepth(this.unitDepth(unit.position));

    const view: UnitView = {
      container,
      bg,
      ring,
      sprite,
      hpBg,
      hpFill,
      cell: { ...unit.position },
      hp: unit.hp,
      maxHp: unit.maxHp,
      team: unit.team,
      tier: unit.tier,
      // Nothing to infer from yet, so start off looking at the other team.
      facing: TEAM_FACING[unit.team],
      dead: false,
    };
    this.views.set(unit.id, view);
    this.play(view, "idle");
    this.layoutUnit(view, true);
    this.applyRing(view, unit.id === this.currentUnitId);

    container.setAlpha(0).setScale(0.6);
    this.tweens.add({
      targets: container,
      alpha: 1,
      scale: 1,
      duration: 300,
      ease: "Back.easeOut",
    });
  }

  /** A unit one row further down overlaps the one behind it, never the reverse. */
  private unitDepth(cell: Cell) {
    return 20 + cell.y;
  }

  private layoutUnit(view: UnitView, snap: boolean) {
    const c = this.cellSize;
    if (snap) view.container.setPosition(this.px(view.cell.x), this.py(view.cell.y));
    view.bg.setSize(c * 0.94, c * 0.94);
    view.ring.setSize(c * 0.94, c * 0.94);
    const scale = this.spriteScale();
    // Bottom origin sits at the frame's edge, FOOT_INSET below the actual feet;
    // pushing the sprite down by that much lands the feet on the cell's floor.
    view.sprite.setScale(scale).setPosition(0, c * 0.5 + FOOT_INSET * scale);
    view.hpBg.setSize(c * 0.76, Math.max(2, c * 0.09)).setPosition(0, c * 0.44);
    view.hpFill
      .setSize(1, Math.max(2, c * 0.09) - 1)
      .setPosition(-c * 0.36, c * 0.44)
      .setDisplaySize(this.hpWidth(view), Math.max(2, c * 0.09) - 1);
  }

  private applyRing(view: UnitView, active: boolean) {
    if (active === view.ring.visible) return;
    view.ring.setVisible(active);
    view.ringTween?.remove();
    view.ringTween = undefined;
    if (active) {
      view.ring.setAlpha(1);
      view.ringTween = this.tweens.add({
        targets: view.ring,
        alpha: 0.35,
        duration: 700,
        yoyo: true,
        repeat: -1,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Animation state — one idle/walk/attack/death per unit, per facing.

  private play(view: UnitView, anim: CharacterAnim) {
    if (view.dead && anim !== "death") return;
    view.sprite.play(animKey(view.tier, anim, view.facing), true);
  }

  private face(view: UnitView, facing: Facing) {
    if (view.facing === facing) return;
    view.facing = facing;
    // Re-enter the animation that is already running, on the new row.
    const current = view.sprite.anims.currentAnim?.key ?? "";
    const anim = (CHARACTER_ANIMS.find((a) => current.includes(`-${a}-`)) ??
      "idle") as CharacterAnim;
    this.play(view, anim);
  }

  private killUnit(view: UnitView) {
    view.ringTween?.remove();
    view.ring.setVisible(false);
    this.dying.push(view);
    // A strike this unit was still finishing must not pull it back to idle.
    view.sprite.off(Phaser.Animations.Events.ANIMATION_COMPLETE);
    view.dead = true;
    view.hpBg.setVisible(false);
    view.hpFill.setVisible(false);
    this.play(view, "death");
    // Hold the last frame for a beat, then let the body fade out.
    view.sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
      this.tweens.add({
        targets: view.container,
        alpha: 0,
        duration: 500,
        delay: 300,
        ease: "Sine.easeIn",
        onComplete: () => {
          this.dying = this.dying.filter((v) => v !== view);
          view.container.destroy(true);
        },
      });
    });
  }

  private floatNumber({ cell, delta }: Popup) {
    const heal = delta > 0;
    const text = this.add
      .text(
        this.px(cell.x),
        this.py(cell.y) - this.cellSize * 0.35,
        heal ? `+${delta}` : `${delta}`,
        {
          fontFamily: "ui-monospace, monospace",
          fontSize: `${Math.round(this.cellSize * 0.42)}px`,
          fontStyle: "bold",
          color: heal ? "#34d399" : "#f87171",
          stroke: "#000000",
          strokeThickness: 3,
        },
      )
      .setOrigin(0.5)
      .setDepth(40);
    this.tweens.add({
      targets: text,
      y: text.y - this.cellSize * 0.9,
      alpha: 0,
      duration: 1200,
      ease: "Sine.easeOut",
      onComplete: () => text.destroy(),
    });
  }

  // -------------------------------------------------------------------------
  // Turn flourishes — replayed once per turn id.

  playTurn(fx: TurnFx) {
    if (!fx.id || fx.id === this.lastTurnId) return;
    this.lastTurnId = fx.id;

    // Let the movement tween land first, so the strike reads as a strike.
    this.time.delayedCall(MOVE_MS - 60, () => {
      if (fx.actorCell) this.strike(fx.actorCell, fx.targetCell);
      if (!fx.targetCell) return;
      const target = fx.targetCell;
      if (fx.ranged && fx.actorCell) {
        this.throwProjectile(fx.actorCell, target, () => this.impact(target, fx.killed));
      } else {
        this.impact(target, fx.killed);
      }
    });
  }

  private viewAt(cell: Cell) {
    for (const view of [...this.views.values(), ...this.dying]) {
      if (view.cell.x === cell.x && view.cell.y === cell.y) return view;
    }
    return undefined;
  }

  /** The attacker turns toward its target and swings, then settles back to idle. */
  private strike(cell: Cell, target: Cell | undefined) {
    const view = this.viewAt(cell);
    if (!view) return;
    if (target) this.face(view, facingFor(cell, target) ?? view.facing);
    this.play(view, "attack");
    view.sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
      if (view.container.active) this.play(view, "idle");
    });
  }

  private throwProjectile(from: Cell, to: Cell, onHit: () => void) {
    const x0 = this.px(from.x);
    const y0 = this.py(from.y);
    const x1 = this.px(to.x);
    const y1 = this.py(to.y);
    const dot = this.add
      .image(x0, y0, "spark")
      .setDisplaySize(this.cellSize * 0.2, this.cellSize * 0.2)
      .setTint(0xfde68a)
      .setDepth(30);
    const lift = Phaser.Math.Distance.Between(x0, y0, x1, y1) * 0.18;
    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 260,
      ease: "Sine.easeIn",
      onUpdate: (tween) => {
        const t = tween.getValue() ?? 0;
        dot.setPosition(
          Phaser.Math.Linear(x0, x1, t),
          Phaser.Math.Linear(y0, y1, t) - Math.sin(Math.PI * t) * lift,
        );
      },
      onComplete: () => {
        dot.destroy();
        onHit();
      },
    });
  }

  private impact(cell: Cell, killed: boolean) {
    const x = this.px(cell.x);
    const y = this.py(cell.y);

    const burst = this.add.particles(x, y, "spark", {
      speed: { min: this.cellSize * 0.8, max: this.cellSize * 2.4 },
      lifespan: 320,
      quantity: 10,
      scale: { start: this.cellSize / 90, end: 0 },
      tint: [0xfde68a, 0xf87171],
      emitting: false,
    });
    burst.setDepth(30).explode(10);
    this.time.delayedCall(600, () => burst.destroy());

    const view = this.viewAt(cell);
    if (view) {
      const shake = this.cellSize * 0.16;
      this.tweens.add({
        targets: view.container,
        x: { from: x - shake, to: x },
        duration: 260,
        ease: "Elastic.easeOut",
      });
      view.sprite.setTintFill(0xffffff);
      this.time.delayedCall(110, () => view.sprite.clearTint());
    }
    if (killed) this.cameras.main.shake(220, 0.006);
  }
}
