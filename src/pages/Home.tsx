import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "convex/react";
import { SignInButton, UserButton } from "@clerk/clerk-react";
import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { api } from "../../convex/_generated/api";
import { getApiKey, setApiKey } from "../lib/session";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-8 px-6 py-12">
      <header className="text-center">
        <h1 className="text-5xl font-bold tracking-tight">TacticsLM</h1>
        <p className="mt-2 text-zinc-400">3 Bodies. 3 Brains. One Arena.</p>
      </header>

      <AuthLoading>
        <p className="text-center text-zinc-500">Loading…</p>
      </AuthLoading>

      <Unauthenticated>
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-zinc-400">Sign in to build your squad and fight.</p>
          <SignInButton mode="modal">
            <button className="rounded-lg bg-emerald-600 px-6 py-3 font-semibold text-white transition hover:bg-emerald-500">
              Sign in
            </button>
          </SignInButton>
        </div>
      </Unauthenticated>

      <Authenticated>
        <Lobby />
      </Authenticated>
    </main>
  );
}

function Lobby() {
  const navigate = useNavigate();
  const createRoom = useMutation(api.rooms.create);
  const [key, setKey] = useState(getApiKey());
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function validate(): boolean {
    if (!key.trim().startsWith("sk-or-")) {
      setError("Enter your OpenRouter API key (starts with sk-or-).");
      return false;
    }
    setApiKey(key.trim());
    return true;
  }

  async function onCreate() {
    setError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      const { code } = await createRoom({});
      navigate(`/room/${code}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  function onJoin() {
    setError(null);
    if (!validate()) return;
    if (!joinCode.trim()) {
      setError("Enter a room code.");
      return;
    }
    navigate(`/room/${joinCode.trim().toUpperCase()}`);
  }

  return (
    <>
      <div className="flex justify-center">
        <UserButton />
      </div>

      <label className="flex flex-col gap-1 text-sm text-zinc-400">
        OpenRouter API key
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          type="password"
          placeholder="sk-or-…"
          className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-zinc-100 outline-none focus:border-zinc-600"
        />
        <span className="text-xs text-zinc-500">
          Stays in your browser. Powers your own 3 units only.
        </span>
      </label>

      <section className="flex flex-col gap-3">
        <button
          onClick={onCreate}
          disabled={busy}
          className="rounded-lg bg-emerald-600 px-4 py-3 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
        >
          Create a room
        </button>
        <div className="flex gap-2">
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="ROOM CODE"
            className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 tracking-widest text-zinc-100 uppercase outline-none focus:border-zinc-600"
          />
          <button
            onClick={onJoin}
            className="rounded-lg bg-zinc-800 px-4 py-2 font-semibold transition hover:bg-zinc-700"
          >
            Join
          </button>
        </div>
      </section>

      {error && <p className="text-center text-sm text-red-400">{error}</p>}
    </>
  );
}
