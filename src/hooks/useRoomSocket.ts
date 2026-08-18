// One socket per room, and the only place the client turns push events into
// state. Replaces the pile of reactive `useQuery` subscriptions that used to keep
// the room screen live. `src/pages/Room.tsx` owns the one subscription.
//
// ── WHY THE TOKEN IS IN THE QUERY STRING ──────────────────────────────────
// `new WebSocket(url)` takes no headers. There is no option, no second
// argument, no way around it in a browser — so the Clerk token rides in the URL
// and `server/routes/ws.ts` reads `query.token`. That file documents the cost
// (query strings reach access logs in a way `Authorization` does not) and the
// mitigations. Everything on the HTTP side still uses the header, via
// `src/lib/eden.ts`.
//
// ── WHY EVERY CONNECT STARTS WITH AN HTTP FETCH ───────────────────────────
// The socket only carries what happens AFTER it is open. Nothing on the server
// replays missed events — there is no per-socket cursor and no buffer — so a
// client that only listens is permanently behind by whatever it slept through.
// Every connect, including every RECONNECT, therefore re-fetches the whole
// snapshot over HTTP first and then applies events on top. This is not a rare
// edge case: HMR in dev drops the socket on almost every save.
//
// ── WHY `match:state` IS APPLIED WHOLESALE ────────────────────────────────
// `src/components/MatchView.tsx` draws its floating HP-damage numbers by diffing
// consecutive `units` arrays. If this hook merged unit fields individually, or
// reused the previous array when "nothing looked different", the board would
// still render perfectly and the damage popups would just stop appearing —
// a regression nobody files a bug about. So the snapshot replaces `match` and
// `units` outright, every time, with the arrays the server sent.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Match, Message, Room, Turn, Unit } from "../../shared/types";
import { api, unwrap } from "../lib/eden";

type Team = "a" | "b";

/** Lobby roster entry. Same shape `GET /api/rooms/:id` returns. */
export type LobbyPlayer = {
  _id: string;
  name: string;
  team: Team;
  ready: boolean;
  unitCount: number;
};

/**
 * The events `server/services/broadcast.ts` emits, mirrored. Kept as a literal
 * union rather than imported from the server so the discriminant list here is
 * the thing the reducer is checked against.
 */
type RoomEvent =
  | { type: "lobby:update"; roomId: string; room: Room; players: Array<LobbyPlayer> }
  | { type: "match:start"; roomId: string; matchId: string; match: Match; units: Array<Unit> }
  | { type: "match:state"; roomId: string; matchId: string; match: Match; units: Array<Unit> }
  | { type: "match:turn"; roomId: string; matchId: string; turn: Turn }
  | {
      type: "match:finished";
      roomId: string;
      matchId: string;
      match: Match;
      units: Array<Unit>;
      winnerTeam: Team | "draw";
      messages: Array<Message>;
    };

/** The one event carrying chat, and it only ever arrives on a team channel. */
type TeamEvent = { type: "message:new"; roomId: string; matchId: string; message: Message };

/** The server's first frame, sent from `open` in `server/routes/ws.ts`. */
type HelloEvent = {
  type: "hello";
  roomId: string;
  userId: string;
  team: Team | null;
  spectator: boolean;
};

type PongEvent = { type: "pong" };

type ServerEvent = RoomEvent | TeamEvent | HelloEvent | PongEvent;

export type RoomSocketState = {
  /** Lobby roster and room row, or null before the first fetch resolves. */
  room: Room | null;
  players: Array<LobbyPlayer>;
  /** The live match, replaced wholesale by every snapshot. */
  match: Match | null;
  /** The live board, replaced wholesale by every snapshot. See the note above. */
  units: Array<Unit>;
  /** Turns in arrival order — the replay list. */
  turns: Array<Turn>;
  /** The caller's own team's chat. The enemy's never reaches this client. */
  messages: Array<Message>;
  /** Set once `match:finished` lands, at which point `messages` holds both teams'. */
  winnerTeam: Team | "draw" | null;
  /** From the server's `hello`: authoritative, and not what the client asked for. */
  me: { userId: string; team: Team | null; spectator: boolean } | null;
  connected: boolean;
  /** True while a snapshot fetch is in flight, including on reconnect. */
  loading: boolean;
  error: string | null;
};

const EMPTY: RoomSocketState = {
  room: null,
  players: [],
  match: null,
  units: [],
  turns: [],
  messages: [],
  winnerTeam: null,
  me: null,
  connected: false,
  loading: true,
  error: null,
};

/** Exponential, capped. Jittered so N clients do not re-dial in lockstep. */
function backoffMs(attempt: number): number {
  const base = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5));
  return base / 2 + Math.random() * (base / 2);
}

function socketUrl(roomId: string, token: string | null): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams({ roomId });
  // See the header: browsers cannot put this in a header.
  if (token) params.set("token", token);
  return `${scheme}://${window.location.host}/ws?${params.toString()}`;
}

/**
 * Live room state: lobby, board, replay and the caller's own team chat.
 *
 * @param roomId  the room to follow, or null to stay disconnected.
 * @param getToken  Clerk's `getToken` from `useAuth()`. Called on every dial, so
 *   a reconnect after a long sleep uses a fresh token rather than an expired one.
 */
export function useRoomSocket(
  roomId: string | null,
  getToken: () => Promise<string | null>,
): RoomSocketState & { reconnect: () => void } {
  const [state, setState] = useState<RoomSocketState>(EMPTY);

  // Everything the effect needs but must not re-run for. `getToken` in
  // particular is a new function identity on most Clerk renders, and putting it
  // in the dependency array reconnects the socket on every render.
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;

  const [dialCount, setDialCount] = useState(0);
  const reconnect = useCallback(() => setDialCount((n) => n + 1), []);

  const patch = useCallback((next: Partial<RoomSocketState>) => {
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  /**
   * The full-snapshot fetch. Run before the socket opens and again after every
   * reconnect; the socket is what keeps it fresh, not what establishes it.
   */
  const seed = useCallback(async (id: string): Promise<void> => {
    const lobby = unwrap(await api.api.rooms({ id }).get());
    const live = unwrap(await api.api.matches["by-room"]({ roomId: id }).get());

    // Turns and the caller's own chat, only once there is a match to have them.
    let turns: Array<Turn> = [];
    let messages: Array<Message> = [];
    let winnerTeam: Team | "draw" | null = null;
    if (live) {
      const replay = unwrap(await api.api.matches({ id: live.match._id }).replay.get());
      turns = replay.turns;
      // `replay` withholds chat until the match is finished; `team-messages`
      // returns the caller's own team's, whatever the status. Taking the longer
      // of the two is how a finished match ends up showing both teams'.
      const own = unwrap(await api.api.matches({ id: live.match._id })["team-messages"].get());
      messages = replay.messages.length > own.length ? replay.messages : own;
      winnerTeam = (live.match.winnerTeam as Team | "draw" | null) ?? null;
    }

    setState((prev) => ({
      ...prev,
      room: lobby.room,
      players: lobby.players,
      match: live?.match ?? null,
      units: live?.units ?? [],
      turns,
      messages,
      winnerTeam,
      loading: false,
      error: null,
    }));
  }, []);

  const apply = useCallback((event: ServerEvent) => {
    setState((prev) => {
      switch (event.type) {
        case "hello":
          // The server's own answer to "who am I and what team am I on". Nothing
          // the client says about its team is consulted, here or on the server.
          return {
            ...prev,
            me: { userId: event.userId, team: event.team, spectator: event.spectator },
          };
        case "pong":
          return prev;
        case "lobby:update":
          return { ...prev, room: event.room, players: event.players };
        case "match:start":
          // A new match wipes the previous one's replay and chat rather than
          // appending to them.
          return {
            ...prev,
            match: event.match,
            units: event.units,
            turns: [],
            messages: [],
            winnerTeam: null,
          };
        case "match:state":
          // WHOLESALE. See the header note about MatchView's damage popups.
          return { ...prev, match: event.match, units: event.units };
        case "match:turn":
          return { ...prev, turns: [...prev.turns, event.turn] };
        case "match:finished":
          // The one frame that carries both teams' chat, and only because the
          // match is over — `broadcast.ts` re-checks the status before sending it.
          return {
            ...prev,
            match: event.match,
            units: event.units,
            winnerTeam: event.winnerTeam,
            messages: event.messages,
          };
        case "message:new":
          return { ...prev, messages: [...prev.messages, event.message] };
        default:
          // An event this build does not know about. Ignored, not thrown: a
          // deployed client must survive the server learning a new frame type.
          return prev;
      }
    });
  }, []);

  useEffect(() => {
    if (!roomId) {
      setState(EMPTY);
      return;
    }

    let cancelled = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const dial = async (): Promise<void> => {
      if (cancelled) return;
      patch({ loading: true });

      // Snapshot FIRST, every time. Anything that happened while we were down is
      // otherwise gone for good.
      try {
        await seed(roomId);
      } catch (error) {
        if (cancelled) return;
        patch({ loading: false, error: error instanceof Error ? error.message : "Request failed" });
        // A failed seed is still worth retrying — the server may just be
        // restarting — but do not open a socket onto state we never established.
        retryTimer = setTimeout(() => void dial(), backoffMs(attempt++));
        return;
      }
      if (cancelled) return;

      const token = await tokenRef.current().catch(() => null);
      if (cancelled) return;

      const ws = new WebSocket(socketUrl(roomId, token));
      socket = ws;

      ws.onopen = () => {
        attempt = 0;
        patch({ connected: true, error: null });
      };
      ws.onmessage = (frame) => {
        try {
          apply(JSON.parse(String(frame.data)) as ServerEvent);
        } catch {
          // A frame we cannot parse is a server bug, not a reason to tear down a
          // working socket.
        }
      };
      ws.onerror = () => {
        // `close` always follows, and that is where the retry lives; doing it
        // here too would dial twice.
      };
      ws.onclose = () => {
        if (cancelled) return;
        patch({ connected: false });
        retryTimer = setTimeout(() => void dial(), backoffMs(attempt++));
      };
    };

    void dial();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      // Drop the handler before closing: `onclose` would otherwise schedule a
      // reconnect for a room we have already navigated away from.
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [roomId, dialCount, seed, apply, patch]);

  return useMemo(() => ({ ...state, reconnect }), [state, reconnect]);
}
