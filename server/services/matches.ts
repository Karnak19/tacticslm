// Match service. Port of `convex/matches.ts`.
//
// `applyTurn` is the whole game. Everything else here is reads plus `forfeit`.

import { and, asc, desc, eq } from "drizzle-orm";
import {
  type Action,
  checkWin,
  type Effect,
  IllegalAction,
  nextTurn,
  resolveStats,
  resolveTurn,
} from "../../shared/engine";
import type { Position } from "../../shared/engine";
import { matches, messages, players, rooms, turns, units } from "../../shared/schema";
import type { Match, Message, Turn, Unit, User } from "../../shared/types";
import type { Db, DbLike, Tx } from "../db/client";
import { publishRoom, publishTeam } from "./broadcast";
import { withLock } from "./lock";
import { CATALOG_MAP, toSnapshot } from "./mappers";

const BASE_MESSAGE_BUDGET = 200; // characters; doubled by the strategist's circlet

export type ApplyTurnArgs = {
  matchId: string;
  unitId: string;
  moveTo?: Position;
  action: Action;
  message?: string;
  thinking?: string;
};

function roomUnits(tx: DbLike, roomId: string): Array<Unit> {
  return tx.select().from(units).where(eq(units.roomId, roomId)).all();
}

/**
 * What the just-committed turn changed, so the socket layer can describe it
 * without re-deriving anything the transaction already knew.
 */
type TurnOutcome = {
  roomId: string;
  /** The PRE-advance turn number: the key of the `turns` row this call inserted. */
  turnNumber: number;
  /** The chatting unit's team, when a message was written. */
  messagedTeam: "a" | "b" | null;
  finished: boolean;
};

/**
 * Take one unit's turn: resolve it, persist it, advance initiative.
 *
 * ── WHO MAY CALL THIS ──────────────────────────────────────────────────────
 * `server/services/brain.ts`, and nothing else. In Convex this was an
 * `internalMutation`, which made it *unreachable* from a client: players could
 * not hand-craft actions, so the LLM really was the one playing. Plain
 * TypeScript has no equivalent — the only thing standing between a route and
 * this function is module discipline. `applyTurn.route-scan.test.ts` makes that
 * discipline mechanical: it fails the build if `applyTurn` appears anywhere under
 * `server/routes/`.
 *
 * ── THE CRITICAL SECTION ───────────────────────────────────────────────────
 * The read of the match, the `currentUnitId === unitId` check, and the writes
 * form one indivisible unit of work. Convex's OCC guaranteed that; here the
 * per-`matchId` mutex plus the synchronous transaction do (see
 * `server/services/lock.ts` for why the transaction alone is not enough).
 *
 * ── ORDER IS LOAD-BEARING ──────────────────────────────────────────────────
 * The sequence below is not stylistic and must not be tidied:
 *
 *   1. resolveTurn                — pure; may throw IllegalAction, and nothing
 *                                   may have been written when it does.
 *   2. persist units              — before the turn row, so a reader that sees
 *                                   turn N sees the state turn N produced.
 *   3. insert the turn row        — stamped with the PRE-advance `turnNumber`.
 *   4. team-chat budget check     — uses the same pre-advance `turnNumber`, and
 *                                   the pre-resolution `unit.loadout` for the
 *                                   budget multiplier.
 *   5. checkWin (pre-advance)     — elimination ends the match on THIS turn;
 *                                   returning here is what leaves
 *                                   `currentUnitId` null and the round un-bumped.
 *   6. nextTurn                   — decides the next unit and whether we wrapped.
 *   7. on wrap: tick cooldowns    — AFTER step 2 persisted the post-resolution
 *                                   cooldowns, so this decrements the new value,
 *                                   not the old one. Doing it before step 2
 *                                   would have the resolution overwrite the tick.
 *   8. on wrap: expire effects    — filtered against the NEW round number.
 *   9. on wrap: checkWin again    — the round cap can only trip on a wrap, and
 *                                   only with the new round number; this second
 *                                   check is how a match ends on points.
 *
 * Steps 5 and 9 both return early, and both flip the room to `finished`.
 */
export async function applyTurn(db: Db, args: ApplyTurnArgs): Promise<void> {
  await withLock(args.matchId, () => {
    // AFTER COMMIT, INSIDE THE LOCK. Both halves of that matter.
    //
    // After commit, because `db.transaction` throws on rollback and the throw
    // skips everything below it: a turn that did not happen is never announced.
    // Convex gave this for free — subscribers only ever saw committed state.
    //
    // Inside the lock, because the mutex is what serialises turns for a match.
    // Broadcasting outside it would let turn N+1's transaction commit and
    // publish while turn N's publish was still queued, so sockets would see a
    // different order than the database has. The client applies `match:state`
    // blind, so out-of-order frames mean a board that rewinds.
    const outcome = db.transaction((tx) => applyTurnLocked(tx, args));
    broadcastTurn(db, args.matchId, outcome);
  });
}

function applyTurnLocked(tx: Tx, args: ApplyTurnArgs): TurnOutcome {
  const match = tx.select().from(matches).where(eq(matches._id, args.matchId)).get();
  if (!match || match.status !== "running") throw new Error("Match is not running");
  if (match.currentUnitId !== args.unitId) throw new Error("Not this unit's turn");

  const unit = tx.select().from(units).where(eq(units._id, args.unitId)).get();
  if (!unit) throw new Error("Unit not found");

  const all = roomUnits(tx, match.roomId);
  const snapshot = toSnapshot(match, all);

  let resolution;
  try {
    resolution = resolveTurn(snapshot, CATALOG_MAP, args.unitId, args.moveTo, args.action);
  } catch (e) {
    if (e instanceof IllegalAction) throw new Error(`Illegal action: ${e.message}`);
    throw e;
  }
  const { snapshot: next, events } = resolution;

  // 2. Persist unit state.
  for (const engineUnit of next.units) {
    tx.update(units)
      .set({
        position: engineUnit.position,
        hp: engineUnit.hp,
        alive: engineUnit.alive,
        activeCooldown: engineUnit.activeCooldown,
        usedConsumables: engineUnit.usedConsumables,
        lastActedRound: engineUnit.lastActedRound,
      })
      .where(eq(units._id, engineUnit.id))
      .run();
  }

  // 3. Record the turn (the replay).
  tx.insert(turns)
    .values({
      matchId: args.matchId,
      turnNumber: match.turnNumber,
      unitId: args.unitId,
      moveTo: args.moveTo ?? null,
      action: args.action,
      summary: events.join(" "),
      thinking: args.thinking?.slice(0, 500) ?? null,
    })
    .run();

  // 4. Team chat, budget enforced server-side. The clamp is an authority check,
  // not a UI nicety: the caller's `message` is model output and is never trusted
  // for length. `resolveStats` reads the unit's own loadout, so the strategist's
  // circlet is the only thing that can widen it.
  let messagedTeam: "a" | "b" | null = null;
  if (args.message && args.message.trim().length > 0) {
    messagedTeam = unit.team;
    const stats = resolveStats(unit.loadout, CATALOG_MAP);
    const budget = BASE_MESSAGE_BUDGET * stats.messageBudgetMultiplier;
    tx.insert(messages)
      .values({
        matchId: args.matchId,
        unitId: args.unitId,
        team: unit.team,
        turnNumber: match.turnNumber,
        text: args.message.trim().slice(0, budget),
      })
      .run();
  }

  // 5. Win check before advancing.
  const win = checkWin(next, match.turnCap);
  if (win.finished) {
    finish(tx, match, {
      winnerTeam: win.winnerTeam,
      effects: next.effects,
      turnNumber: match.turnNumber + 1,
    });
    return { roomId: match.roomId, turnNumber: match.turnNumber, messagedTeam, finished: true };
  }

  // 6. Advance to the next living unit.
  const advance = nextTurn(match.initiative, match.initiativeIndex, match.roundNumber, next.units);
  if (!advance) throw new Error("No living units to advance to");

  let effects = next.effects;
  if (advance.wrapped) {
    // 7-9. New round: tick cooldowns, drop expired effects, re-check the round cap.
    for (const engineUnit of next.units) {
      if (engineUnit.alive && engineUnit.activeCooldown > 0) {
        tx.update(units)
          .set({ activeCooldown: engineUnit.activeCooldown - 1 })
          .where(eq(units._id, engineUnit.id))
          .run();
      }
    }
    effects = effects.filter((e: Effect) => e.expiresAfterRound >= advance.roundNumber);
    const cappedWin = checkWin({ ...next, roundNumber: advance.roundNumber }, match.turnCap);
    if (cappedWin.finished) {
      finish(tx, match, {
        winnerTeam: cappedWin.winnerTeam,
        effects,
        turnNumber: match.turnNumber + 1,
        roundNumber: advance.roundNumber,
      });
      return { roomId: match.roomId, turnNumber: match.turnNumber, messagedTeam, finished: true };
    }
  }

  tx.update(matches)
    .set({
      turnNumber: match.turnNumber + 1,
      roundNumber: advance.roundNumber,
      initiativeIndex: advance.index,
      currentUnitId: advance.unitId,
      effects,
    })
    .where(eq(matches._id, args.matchId))
    .run();

  return { roomId: match.roomId, turnNumber: match.turnNumber, messagedTeam, finished: false };
}

/**
 * Describe a committed turn to the room, and — separately — to one team.
 *
 * Reads are re-issued against the committed database rather than threaded out
 * of the transaction, so what goes on the wire is exactly what a client would
 * get from `GET /api/matches/by-room/:roomId`. One source of truth for "the
 * state", and no chance of the socket and the HTTP fetch disagreeing after a
 * reconnect re-seeds.
 *
 * ORDER: `match:turn` (append to the replay), then `match:state` (the full
 * snapshot the board renders from), then the team-only chat frame. The state
 * frame is a WHOLE `{ match, units }` snapshot on purpose — `MatchView` derives
 * its damage numbers by diffing consecutive `units` arrays.
 *
 * The chat frame goes through `publishTeam` and nothing else. Folding it into
 * the `match:state` payload is the one-line change that leaks the enemy's plans
 * to anyone with devtools open; `broadcast.ts` will throw if you try.
 */
function broadcastTurn(db: DbLike, matchId: string, outcome: TurnOutcome): void {
  const { roomId } = outcome;
  const state = byRoom(db, roomId);
  if (!state) return;

  const turn = db
    .select()
    .from(turns)
    .where(and(eq(turns.matchId, matchId), eq(turns.turnNumber, outcome.turnNumber)))
    .get();
  // `turn.thinking` ships as-is, live, to both teams and any spectator. That is
  // deliberate: watching three independent brains reason about the same board is
  // the product, not a side effect of it. It is also not a secret worth keeping —
  // no unit's prompt ever reads another unit's reasoning (readTurnContext feeds
  // each model only its OWN team's chat), and a human cannot act on it mid-match
  // because applyTurn is reachable only from the brain. The secrecy boundary that
  // matters is team chat, and it is enforced in the prompt and in publishTeam.
  if (turn) publishRoom(roomId, { type: "match:turn", roomId, matchId, turn });

  publishRoom(roomId, { type: "match:state", roomId, matchId, ...state });

  if (outcome.messagedTeam) {
    const message = db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.matchId, matchId),
          eq(messages.team, outcome.messagedTeam),
          eq(messages.turnNumber, outcome.turnNumber),
        ),
      )
      .get();
    if (message) {
      publishTeam(roomId, outcome.messagedTeam, {
        type: "message:new",
        roomId,
        matchId,
        message,
      });
    }
  }

  if (outcome.finished) broadcastFinished(db, matchId, roomId);
}

/**
 * The end of the match, and the only room-channel frame that carries chat.
 *
 * It mirrors `replay` exactly: the reveal is gated on `status === "finished"`,
 * read back from the committed row rather than assumed from the caller. If that
 * check ever stops matching `replay`'s, the socket becomes a way to read the
 * enemy's messages one turn early.
 */
function broadcastFinished(db: DbLike, matchId: string, roomId: string): void {
  const state = byRoom(db, roomId);
  if (!state || state.match.status !== "finished") return;
  publishRoom(roomId, {
    type: "match:finished",
    roomId,
    matchId,
    match: state.match,
    units: state.units,
    winnerTeam: state.match.winnerTeam ?? "draw",
    messages: db.select().from(messages).where(eq(messages.matchId, matchId)).all(),
  });
}

/**
 * End the match and the room together. `currentUnitId` becomes null (Convex used
 * `undefined`, which deleted the field — same meaning: nobody is on the clock).
 */
function finish(
  tx: Tx,
  match: Match,
  patch: {
    winnerTeam: "a" | "b" | "draw";
    effects?: Array<Effect>;
    turnNumber?: number;
    roundNumber?: number;
  },
): void {
  tx.update(matches)
    .set({
      status: "finished",
      winnerTeam: patch.winnerTeam,
      currentUnitId: null,
      ...(patch.effects === undefined ? {} : { effects: patch.effects }),
      ...(patch.turnNumber === undefined ? {} : { turnNumber: patch.turnNumber }),
      ...(patch.roundNumber === undefined ? {} : { roundNumber: patch.roundNumber }),
    })
    .where(eq(matches._id, match._id))
    .run();
  tx.update(rooms).set({ status: "finished" }).where(eq(rooms._id, match.roomId)).run();
}

/**
 * Live match state — everything both players may see (positions, HP, effects).
 * Team chat is NOT here; see `teamMessages`.
 */
export function byRoom(db: DbLike, roomId: string): { match: Match; units: Array<Unit> } | null {
  const match = db
    .select()
    .from(matches)
    .where(eq(matches.roomId, roomId))
    .orderBy(desc(matches._creationTime))
    .get();
  if (!match) return null;
  return { match, units: roomUnits(db, roomId) };
}

/**
 * Team chat for the requesting player's team only.
 *
 * SECRECY BOUNDARY. The team is resolved from the caller's own `players` row and
 * is never accepted as a parameter — that is the entire mechanism keeping one
 * team's plans out of the other team's client. A non-player of the room gets an
 * empty list, same as Convex.
 */
export function teamMessages(db: DbLike, user: User | null, matchId: string): Array<Message> {
  if (!user) return [];
  const match = db.select().from(matches).where(eq(matches._id, matchId)).get();
  if (!match) return [];
  const player = db
    .select()
    .from(players)
    .where(and(eq(players.userId, user._id), eq(players.roomId, match.roomId)))
    .get();
  if (!player) return [];
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.matchId, matchId), eq(messages.team, player.team)))
    .all();
}

/**
 * Full replay: all turns and (once finished) both teams' messages.
 *
 * SECRECY BOUNDARY. The `status === "finished"` guard on `messages` is what stops
 * a spectator — or a player — from reading the enemy's chat mid-match by asking
 * for the replay instead of `teamMessages`. It is not an optimisation; do not
 * hoist the query out of the conditional.
 */
export function replay(
  db: DbLike,
  matchId: string,
): { match: Match; turns: Array<Turn>; messages: Array<Message> } | null {
  const match = db.select().from(matches).where(eq(matches._id, matchId)).get();
  if (!match) return null;
  const matchTurns = db
    .select()
    .from(turns)
    .where(eq(turns.matchId, matchId))
    .orderBy(asc(turns.turnNumber))
    .all();
  // Turns carry `thinking` at any point in the match — see broadcastTurn for why
  // it is not a secret. Team chat is, and stays gated on `finished`.
  const revealed =
    match.status === "finished"
      ? db.select().from(messages).where(eq(messages.matchId, matchId)).all()
      : [];
  return { match, turns: matchTurns, messages: revealed };
}

/** Forfeit: any player in the room can concede; the other team wins. */
export async function forfeit(db: Db, user: User | null, matchId: string): Promise<void> {
  if (!user) throw new Error("Not authenticated");
  // Same lock as `applyTurn`: a forfeit landing halfway through a turn would
  // otherwise resurrect the match by writing `currentUnitId` after we cleared it.
  await withLock(matchId, () => {
    const roomId = db.transaction((tx) => {
      const match = tx.select().from(matches).where(eq(matches._id, matchId)).get();
      if (!match || match.status !== "running") throw new Error("Match is not running");
      const player = tx
        .select()
        .from(players)
        .where(and(eq(players.userId, user._id), eq(players.roomId, match.roomId)))
        .get();
      if (!player) throw new Error("Not a player in this room");
      finish(tx, match, { winnerTeam: player.team === "a" ? "b" : "a" });
      return match.roomId;
    });
    // Same rule as `applyTurn`: after commit, inside the lock. A conceded match
    // that failed to commit must never be announced as over.
    const state = byRoom(db, roomId);
    if (state) {
      publishRoom(roomId, { type: "match:state", roomId, matchId, ...state });
      broadcastFinished(db, matchId, roomId);
    }
  });
}
