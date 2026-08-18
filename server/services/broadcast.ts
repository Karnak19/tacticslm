// The push layer. Replaces Convex's reactive queries.
//
// Convex re-ran every subscribed query after every write, so no code ever had to
// decide *who* was allowed to see *what* after a turn — the query functions had
// already decided, once, and the reactivity respected them. With sockets that
// decision moves here, and it is easy to get wrong in a way nothing visibly
// breaks. So the whole fan-out is squeezed through this one module.
//
// ── THE ONE RULE ───────────────────────────────────────────────────────────
// This is the ONLY module in the codebase that may call `server.publish`.
// Everything else calls `publishRoom` or `publishTeam`. That is not tidiness:
// it is the only place a reviewer has to look to answer "can team A read team
// B's chat over the socket?".
//
// ── THE BUG THIS IS SHAPED AROUND ──────────────────────────────────────────
// The tempting one-liner after a turn is
//
//     publish(`room:${roomId}`, { state, messages })
//
// It is one line, every client renders correctly (each one filters chat by its
// own team before drawing it), and it silently hands the enemy's plans to
// anyone who opens devtools. `matches.teamMessages` takes no team parameter and
// `matches.replay` withholds chat until the match is finished precisely to stop
// that over HTTP; the socket must not be the back door. Hence the split
// signature, the `RoomEvent` union that has no message-bearing member, and the
// runtime assertion in `publishRoom` that re-checks it anyway.
//
// The one sanctioned exception mirrors `replay`: once a match is `finished`,
// everybody may read everything, so `match:finished` carries both teams' chat
// to the room channel. `assertNoSecretChat` allows that member and only that
// member, and only after checking the status field itself.

import type { Match, Message, Room, Turn, Unit } from "../../shared/types";

export type Team = "a" | "b";

/** Lobby roster entry, as `rooms.get` returns it. */
export type LobbyPlayer = {
  _id: string;
  name: string;
  team: Team;
  ready: boolean;
  unitCount: number;
};

/**
 * Events every socket in the room may see.
 *
 * `match:state` carries the WHOLE `{ match, units }` snapshot and must keep
 * doing so. `src/components/MatchView.tsx` derives its floating HP-damage
 * numbers by diffing consecutive `units` arrays; granular field patches would
 * render a perfectly correct board with no damage popups on it, which is the
 * kind of regression nobody files a bug about.
 */
export type RoomEvent =
  | { type: "lobby:update"; roomId: string; room: Room; players: Array<LobbyPlayer> }
  | { type: "match:start"; roomId: string; matchId: string; match: Match; units: Array<Unit> }
  | { type: "match:state"; roomId: string; matchId: string; match: Match; units: Array<Unit> }
  // Carries `turn.thinking` live, on purpose: three brains reasoning aloud about
  // one board is the product. It is not inside the secrecy boundary — no prompt
  // reads another unit's reasoning, and a human takes no turns. Team chat IS
  // inside it, which is what publishTeam below exists for.
  | { type: "match:turn"; roomId: string; matchId: string; turn: Turn }
  | {
      type: "match:finished";
      roomId: string;
      matchId: string;
      match: Match;
      units: Array<Unit>;
      winnerTeam: "a" | "b" | "draw";
      /** Both teams' chat, revealed. Legal ONLY because the match is over. */
      messages: Array<Message>;
    };

/** The only event that carries message text, and it never leaves a team channel. */
export type TeamEvent = { type: "message:new"; roomId: string; matchId: string; message: Message };

export type AnyEvent = RoomEvent | TeamEvent;

export function roomTopic(roomId: string): string {
  return `room:${roomId}`;
}

export function teamTopic(roomId: string, team: Team): string {
  return `room:${roomId}:team:${team}`;
}

/**
 * How bytes actually reach sockets. `server/routes/ws.ts` installs the real one
 * (`server.publish`) at startup; until then publishing is a no-op, which is what
 * we want for the service tests that never open a listener.
 */
type Publisher = (topic: string, payload: string) => void;

let publisher: Publisher | null = null;

export function setPublisher(next: Publisher | null): void {
  publisher = next;
}

/**
 * Test seam: every event this module emits, in order, with its topic. Off by
 * default so production pays nothing for it.
 */
export type Recorded = { topic: string; event: AnyEvent };
let recorder: Array<Recorded> | null = null;

export function startRecording(): Array<Recorded> {
  recorder = [];
  return recorder;
}

export function stopRecording(): void {
  recorder = null;
}

/**
 * Belt and braces for the union above. The type system already forbids handing
 * `publishRoom` an event with chat in it, but types are erased and this file is
 * the security boundary, so the check also exists at runtime.
 */
function assertNoSecretChat(event: RoomEvent): void {
  if (event.type === "match:finished") {
    // Mirrors `matches.replay`: chat is revealed by the match being over, and by
    // nothing else. If the caller hands us a "finished" event for a match that
    // is not finished, that is the bug we are here to catch.
    if (event.match.status !== "finished") {
      throw new Error("broadcast: refusing to reveal chat for a match that is not finished");
    }
    return;
  }
  if ("messages" in event || "message" in event) {
    throw new Error(`broadcast: ${event.type} must not carry message text on the room channel`);
  }
}

function send(topic: string, event: AnyEvent): void {
  recorder?.push({ topic, event });
  publisher?.(topic, JSON.stringify(event));
}

/** Fan out to both players and every spectator of the room. */
export function publishRoom(roomId: string, event: RoomEvent): void {
  assertNoSecretChat(event);
  send(roomTopic(roomId), event);
}

/**
 * Fan out to one team only.
 *
 * `team` comes from a `players` row read server-side — never from anything a
 * client said. See `server/routes/ws.ts`, which is the only place a socket is
 * subscribed to a team topic.
 */
export function publishTeam(roomId: string, team: Team, event: TeamEvent): void {
  send(teamTopic(roomId, team), event);
}
