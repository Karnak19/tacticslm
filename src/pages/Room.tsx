// The room screen. Convex-free: the lobby code is resolved over HTTP once, and
// everything that has to stay live — the opponent joining, both players readying,
// the match starting and then every turn of it — arrives on the one WebSocket
// `useRoomSocket` owns.
//
// WHY THE SOCKET IS OPENED HERE AND NOT IN `MatchView`
// The lobby and the match are the same subscription: `lobby:update` flips
// `room.status` from "lobby" to "active" and `match:start` delivers the board on
// the same frame sequence. Opening one socket per screen would mean tearing it
// down exactly when the interesting events fire, and the child that mounted
// second would miss whatever landed before it dialled. So the socket lives at
// this level and both children read the same snapshot.
//
// `Authenticated` / `Unauthenticated` / `AuthLoading` came from `convex/react`,
// which wrapped Clerk's own state. Clerk's `useAuth()` is that state, so the
// gate is written out directly rather than through a wrapper we no longer have.

import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { SignInButton, useAuth } from "@clerk/clerk-react";
import type { Room as RoomRow } from "../../shared/types";
import { api, unwrap } from "../lib/eden";
import { useRoomSocket } from "../hooks/useRoomSocket";
import SquadBuilder from "../components/SquadBuilder";
import MatchView from "../components/MatchView";

export default function Room() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) return <Centered>Loading…</Centered>;
  if (!isSignedIn) {
    return (
      <Centered>
        <span className="mr-3">Sign in to enter this room.</span>
        <SignInButton mode="modal">
          <button className="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white">
            Sign in
          </button>
        </SignInButton>
      </Centered>
    );
  }
  return <RoomInner />;
}

function RoomInner() {
  const { code } = useParams<{ code: string }>();
  const { getToken } = useAuth();

  // `undefined` = still looking, `null` = no such room. Same three states the
  // Convex query had, so the render branches below are unchanged.
  const [room, setRoom] = useState<RoomRow | null | undefined>(undefined);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinedRoomId, setJoinedRoomId] = useState<string | null>(null);
  const joined = useRef(false);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    api.api.rooms["by-code"]({ code })
      .get()
      .then((result) => {
        const found = unwrap(result);
        if (!cancelled) setRoom(found);
      })
      .catch(() => {
        // 404 is the "no such room" answer, and every other failure reads the
        // same to a player standing in front of a lobby code that does not work.
        if (!cancelled) setRoom(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  // Auto-join, exactly once. A no-op for a player already in the room (`join`
  // returns their existing row), and a clean error when the room is full.
  //
  // The socket is not dialled until this resolves: `ws.ts` reads the caller's
  // team out of their `players` row at upgrade, so connecting before the row
  // exists gets a spectator socket with no team channel — no team chat, for the
  // life of that connection.
  useEffect(() => {
    if (!room || joined.current) return;
    joined.current = true;
    api.api.rooms
      .join({ code: room.code })
      .post()
      .then((result) => setJoinedRoomId(unwrap(result).roomId))
      .catch((e: unknown) => setJoinError(e instanceof Error ? e.message : String(e)));
  }, [room]);

  const socket = useRoomSocket(joinedRoomId, getToken);

  if (room === undefined) return <Centered>Loading…</Centered>;
  if (room === null) {
    return (
      <Centered>
        Room not found.{" "}
        <Link to="/" className="text-emerald-400 underline">
          Back home
        </Link>
      </Centered>
    );
  }
  if (joinError) {
    return (
      <Centered>
        {joinError}{" "}
        <Link to="/" className="text-emerald-400 underline">
          Back home
        </Link>
      </Centered>
    );
  }
  // The socket's room row, not the one `by-code` returned: that one is a
  // snapshot from before the join and never learns that the match started.
  const live = socket.room;
  if (!live) return <Centered>{socket.error ?? "Loading…"}</Centered>;

  if (live.status === "lobby") {
    return <SquadBuilder room={live} players={socket.players} />;
  }
  return <MatchView room={live} socket={socket} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center text-zinc-400">
      <p>{children}</p>
    </div>
  );
}
