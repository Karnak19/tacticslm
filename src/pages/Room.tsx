import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "convex/react";
import { SignInButton } from "@clerk/clerk-react";
import { api } from "../../convex/_generated/api";
import SquadBuilder from "../components/SquadBuilder";
import MatchView from "../components/MatchView";

export default function Room() {
  return (
    <>
      <AuthLoading>
        <Centered>Loading…</Centered>
      </AuthLoading>
      <Unauthenticated>
        <Centered>
          <span className="mr-3">Sign in to enter this room.</span>
          <SignInButton mode="modal">
            <button className="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white">
              Sign in
            </button>
          </SignInButton>
        </Centered>
      </Unauthenticated>
      <Authenticated>
        <RoomInner />
      </Authenticated>
    </>
  );
}

function RoomInner() {
  const { code } = useParams<{ code: string }>();
  const room = useQuery(api.rooms.byCode, code ? { code } : "skip");
  const join = useMutation(api.rooms.join);
  const [joinError, setJoinError] = useState<string | null>(null);
  const joined = useRef(false);

  // Auto-join (no-op if already a player; fails cleanly if the room is full).
  useEffect(() => {
    if (!room || joined.current) return;
    joined.current = true;
    join({ code: room.code }).catch((e) =>
      setJoinError(e instanceof Error ? e.message : String(e)),
    );
  }, [room, join]);

  const lobby = useQuery(api.rooms.get, room ? { roomId: room._id } : "skip");

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
  if (!lobby) return <Centered>Loading…</Centered>;

  if (room.status === "lobby") {
    return <SquadBuilder room={room} lobby={lobby} />;
  }
  return <MatchView room={room} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center text-zinc-400">
      <p>{children}</p>
    </div>
  );
}
