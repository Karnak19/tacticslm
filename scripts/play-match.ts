#!/usr/bin/env bun
//
// Dev harness for the fighting system: seed a match and either watch it in the
// browser or drive it from the terminal — no second Clerk account, no second
// browser, no ready handshake.
//
//   bun run play --watch                 # seed, print the URL, let the browser drive
//   bun run play --seed                  # seed and drive here, printing the trace
//   bun run play --room 8TQ76C           # attach to an existing room and drive it
//
// Run `bun run play --help` for every flag. Never run watch mode and terminal
// mode against the same match at once: both would fire brain.act on the same
// turn, doubling the LLM spend for nothing (the loser gets "Not this unit's
// turn" and is skipped, so nothing corrupts — it just muddies the trace).

import { execFileSync } from "node:child_process";

const HELP = `
play-match — seed and drive a TacticsLM match from the CLI

MODES
  --watch                 Seed a match, print its URL, and exit. The browser tab
                          drives every turn (MatchView's brain loop plays both
                          teams because the seeded room's two players share one
                          user). Use this when you want to SEE the fight.
  --seed                  Seed a match and drive it here, printing a turn-by-turn
                          trace. Use this for headless debugging.
  --room <code>           Attach to an existing room and drive it.
  --match <matchId>       Attach to an existing match id and drive it.

SEED OPTIONS (--watch / --seed)
  --model <id>            Override every unit's model (default: per starter unit).
  --grid <n>              Grid size (default 12).
  --map-seed <n>          Fixed wall-generation seed → reproducible terrain.
  --team-a <a,b,c>        Starter unit names for team A (default all three).
  --team-b <a,b,c>        Starter unit names for team B.

DRIVER OPTIONS
  --max-turns <n>         Stop after this many turns (default 120).
  --quiet                 Hide the model's thinking / team chat.

ENV
  OPENROUTER_API_KEY      Required to drive turns (not needed for --watch).
                          The key transits to OpenRouter through the brain
                          action only; it is never stored server-side.

WARNING: do not drive from the terminal while a browser tab is open on the same
match — both will try to take the same turn.
`;

// ── CLI ────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}
function num(name: string): number | undefined {
  const raw = opt(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) die(`--${name} must be a number, got "${raw}"`);
  return n;
}
function list(name: string): Array<string> | undefined {
  return opt(name)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
function die(message: string): never {
  console.error(`\n${red("error")} ${message}\n`);
  process.exit(1);
}

// ── colours ───────────────────────────────────────────────────────────────────

const tty = process.stdout.isTTY;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = wrap("1");
const dim = wrap("2");
const red = wrap("31");
const green = wrap("32");
const yellow = wrap("33");
const blue = wrap("36");
const magenta = wrap("35");

// ── convex CLI bridge ─────────────────────────────────────────────────────────
// `dev:*` functions are internal, so they are only reachable through the CLI's
// admin key — hence shelling out rather than using ConvexHttpClient.

function convexRun<T>(fn: string, args: Record<string, unknown>): T {
  let stdout: string;
  try {
    stdout = execFileSync("bunx", ["convex", "run", fn, JSON.stringify(args)], {
      encoding: "utf8",
      // Convex prints function logs on stderr; let them through — that is where
      // brain.act's LLM failures show up.
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    die(`\`convex run ${fn}\` failed. Is \`bunx convex dev\` running?\n  ${String(e)}`);
  }
  const text = stdout.trim();
  return (text.length === 0 ? null : JSON.parse(text)) as T;
}

// ── shapes returned by convex/dev.ts ──────────────────────────────────────────

type Cell = { x: number; y: number };
type Team = "a" | "b";

type Seeded = {
  roomId: string;
  matchId: string;
  code: string;
  url: string;
  playerName: string;
};

type TurnRow = {
  turnNumber: number;
  unitName: string;
  team: Team;
  moveTo?: Cell;
  action:
    | { kind: "attack"; targetUnitId: string }
    | { kind: "active"; targetCell?: Cell; targetUnitId?: string }
    | { kind: "consumable"; slug: string; targetCell?: Cell; targetUnitId?: string }
    | { kind: "wait" };
  targetName?: string;
  summary: string;
  thinking?: string;
  message?: string;
};

type UnitRow = {
  name: string;
  team: Team;
  model: string;
  hp: number;
  alive: boolean;
  position?: Cell;
};

type Trace = {
  status: "running" | "finished";
  turnNumber: number;
  roundNumber: number;
  turnCap: number;
  gridSize: number;
  winnerTeam?: Team | "draw";
  currentUnitName?: string;
  units: Array<UnitRow>;
  turns: Array<TurnRow>;
};

type TurnResult = { status: "ok" | "skipped" | "error"; reason?: string };

// ── rendering ─────────────────────────────────────────────────────────────────

const teamColor = (team: Team) => (team === "a" ? blue : magenta);
const tag = (name: string, team: Team) => teamColor(team)(`${name} [${team.toUpperCase()}]`);
const cell = (c: Cell | undefined) => (c ? `(${c.x},${c.y})` : "—");

function describeAction(turn: TurnRow): string {
  switch (turn.action.kind) {
    case "wait":
      return "waits";
    case "attack":
      return `attacks ${turn.targetName ?? "?"}`;
    case "active":
      return `uses its active${turn.targetName ? ` on ${turn.targetName}` : ""}${
        turn.action.targetCell ? ` at ${cell(turn.action.targetCell)}` : ""
      }`;
    case "consumable":
      return `uses ${turn.action.slug}${turn.targetName ? ` on ${turn.targetName}` : ""}${
        turn.action.targetCell ? ` at ${cell(turn.action.targetCell)}` : ""
      }`;
  }
}

function hpMap(units: Array<UnitRow>): Map<string, number> {
  return new Map(units.map((u) => [u.name, u.hp]));
}

function printRoster(trace: Trace): void {
  const models = new Set(trace.units.map((u) => u.model));
  console.log(
    `${bold("roster")}  ${trace.units.map((u) => `${tag(u.name, u.team)} ${u.hp}hp`).join("  ")}\n` +
      `${dim(`models: ${[...models].join(", ")}`)}\n` +
      `${dim(`grid ${trace.gridSize}×${trace.gridSize}, round cap ${trace.turnCap}`)}`,
  );
}

function printTurn(turn: TurnRow, before: Map<string, number>, after: Map<string, number>): void {
  const head = `${dim(`turn ${String(turn.turnNumber).padStart(3)}`)}  ${tag(turn.unitName, turn.team)}`;
  const move = turn.moveTo ? `moves ${cell(turn.moveTo)} → ` : "";
  console.log(`${head}  ${move}${bold(describeAction(turn))}`);

  const deltas: Array<string> = [];
  for (const [name, hp] of after) {
    const was = before.get(name);
    if (was === undefined || was === hp) continue;
    const d = hp - was;
    const text = `${name} ${was}→${hp} (${d > 0 ? `+${d}` : d})`;
    deltas.push(d < 0 ? red(text) : green(text));
  }
  if (deltas.length > 0) console.log(`         ${deltas.join("  ")}`);
  if (turn.summary) console.log(`         ${dim(turn.summary)}`);
  return;
}

function printBrainError(turn: TurnRow): boolean {
  if (!turn.thinking?.startsWith("(brain error")) return false;
  console.log(`         ${red(bold("BRAIN ERROR"))} ${red(turn.thinking)}`);
  return true;
}

// ── seeding ───────────────────────────────────────────────────────────────────

function seed(): Seeded {
  const seedArgs: Record<string, unknown> = {};
  const model = opt("model");
  if (model) seedArgs.model = model;
  const grid = num("grid");
  if (grid !== undefined) seedArgs.gridSize = grid;
  const mapSeed = num("map-seed");
  if (mapSeed !== undefined) seedArgs.seed = mapSeed;
  const teamA = list("team-a");
  if (teamA) seedArgs.teamA = teamA;
  const teamB = list("team-b");
  if (teamB) seedArgs.teamB = teamB;

  const seeded = convexRun<Seeded>("dev:seedMatch", seedArgs);
  console.log(
    `\n${green(bold("seeded"))} room ${bold(seeded.code)} for ${seeded.playerName}\n` +
      `  watch it: ${bold(seeded.url)}\n` +
      `  match id: ${dim(seeded.matchId)}\n`,
  );
  return seeded;
}

// ── driving ───────────────────────────────────────────────────────────────────

function drive(matchId: string, apiKey: string, maxTurns: number, quiet: boolean): void {
  let trace = convexRun<Trace>("dev:matchTrace", { matchId, sinceTurn: -1 });
  // Attaching mid-match: only trace what happens from here on.
  let sinceTurn = trace.turnNumber - 1;
  printRoster(trace);

  if (trace.status === "finished") {
    console.log(yellow("\nthis match is already finished."));
    report(trace);
    return;
  }

  let played = 0;
  let idle = 0;
  let brainErrors = 0;
  while (trace.status === "running" && played < maxTurns) {
    console.log(
      dim(
        `\n── round ${trace.roundNumber}/${trace.turnCap} · ${trace.currentUnitName ?? "?"} to act ──`,
      ),
    );
    const started = Date.now();
    const result = convexRun<TurnResult>("dev:act", { matchId, apiKey });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    const before = hpMap(trace.units);
    const next = convexRun<Trace>("dev:matchTrace", { matchId, sinceTurn });
    const after = hpMap(next.units);

    if (next.turns.length === 0) {
      idle++;
      console.log(
        yellow(`  no turn recorded (${result.status}${result.reason ? `: ${result.reason}` : ""})`),
      );
      if (idle >= 3) {
        die(
          "three calls in a row produced no turn. Is a browser tab driving this " +
            "match too, or did the match stop being 'running'?",
        );
      }
    } else {
      idle = 0;
    }

    for (const turn of next.turns) {
      printTurn(turn, before, after);
      if (printBrainError(turn)) brainErrors++;
      else if (!quiet && turn.thinking) console.log(`         ${dim(`“${turn.thinking}”`)}`);
      if (!quiet && turn.message) console.log(`         ${yellow(`says: “${turn.message}”`)}`);
      sinceTurn = Math.max(sinceTurn, turn.turnNumber);
      played++;
    }
    console.log(dim(`         ${seconds}s`));
    trace = next;
  }

  if (trace.status === "running") console.log(yellow(`\nstopped at the ${maxTurns}-turn cap.`));
  report(trace);
  if (brainErrors > 0) {
    console.log(red(`${brainErrors} of ${played} turns fell back to "wait" after an LLM failure.`));
  } else if (played > 0) {
    console.log(green(`all ${played} turns came back from the model cleanly.`));
  }
}

function report(trace: Trace): void {
  const totals = { a: 0, b: 0 };
  for (const u of trace.units) if (u.alive) totals[u.team] += u.hp;
  const winner =
    trace.winnerTeam === undefined
      ? "unfinished"
      : trace.winnerTeam === "draw"
        ? "draw"
        : `team ${trace.winnerTeam.toUpperCase()}`;
  console.log(
    `\n${bold("result")} ${green(winner)}  ${dim(
      `after ${trace.turnNumber} turns / ${trace.roundNumber} rounds`,
    )}\n` +
      `${bold("final")}  ${trace.units
        .map((u) => (u.alive ? `${tag(u.name, u.team)} ${u.hp}hp` : dim(`${u.name} DEAD`)))
        .join("  ")}\n` +
      `${dim(`team HP: A ${totals.a} · B ${totals.b}`)}`,
  );
}

// ── main ──────────────────────────────────────────────────────────────────────

if (flag("help") || argv.length === 0) {
  console.log(HELP);
  process.exit(0);
}

const watchOnly = flag("watch");
const doSeed = flag("seed") || watchOnly;
const roomCode = opt("room");
const matchArg = opt("match");

if (!doSeed && !roomCode && !matchArg) {
  die("pick a mode: --watch, --seed, --room <code> or --match <matchId>. See --help.");
}

let matchId: string;
if (doSeed) {
  const seeded = seed();
  matchId = seeded.matchId;
} else if (roomCode) {
  const found = convexRun<{ roomId: string; matchId: string } | null>("dev:findMatch", {
    code: roomCode,
  });
  if (!found) die(`no match found for room "${roomCode}".`);
  matchId = found.matchId;
} else {
  matchId = matchArg!;
}

if (watchOnly) {
  console.log(
    `${bold("watch mode")}: the browser drives every turn. Start the app with ` +
      `${bold("bun run dev")}, open the URL above, and make sure your OpenRouter key is ` +
      `saved in the app (it drives the brain from the browser).\n` +
      dim("Do not also run this script in --seed mode against this match.\n"),
  );
  process.exit(0);
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  die(
    "OPENROUTER_API_KEY is not set. Driving turns needs a real OpenRouter key:\n" +
      "  export OPENROUTER_API_KEY=sk-or-...\n" +
      "  bun run play --seed\n" +
      "(Only --watch works without one; there the browser supplies the key.)",
  );
}

drive(matchId, apiKey, num("max-turns") ?? 120, flag("quiet"));
