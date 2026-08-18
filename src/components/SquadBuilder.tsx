// Squad picking. The lobby roster it renders is pushed by the room socket
// (`lobby:update`), so the opponent appearing and readying shows up here without
// this component subscribing to anything — `src/pages/Room.tsx` owns the socket
// and hands the players down.
//
// The player's own unit roster is a one-shot HTTP read: it is their saved units,
// edited on the dashboard, and nothing in a lobby changes it.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Room, RosterUnit } from "../../shared/types";
import type { LobbyPlayer } from "../hooks/useRoomSocket";
import { api, unwrap } from "../lib/eden";
import { itemIcon, skinSprite } from "../lib/sprites";

const SQUAD_SIZE = 3;

export default function SquadBuilder({
  room,
  players,
}: {
  room: Room;
  players: Array<LobbyPlayer>;
}) {
  const [roster, setRoster] = useState<Array<RosterUnit> | null>(null);
  const [selected, setSelected] = useState<Array<string>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.api.roster
      .get()
      .then((result) => {
        if (!cancelled) setRoster(unwrap(result));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setRoster([]);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!roster) return <p className="p-8 text-zinc-400">Loading roster…</p>;

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id)
        ? prev.filter((s) => s !== id)
        : prev.length < SQUAD_SIZE
          ? [...prev, id]
          : prev,
    );
  }

  async function onReady() {
    setError(null);
    setBusy(true);
    try {
      unwrap(await api.api.rooms({ id: room._id }).squad.post({ rosterUnitIds: selected }));
      // The `match:start` frame that follows is what moves this screen on; the
      // returned match id is not needed here.
      unwrap(await api.api.rooms({ id: room._id }).ready.post({ ready: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Pick your squad</h1>
          <p className="text-sm text-zinc-400">
            Room code:{" "}
            <span className="font-mono text-lg tracking-widest text-emerald-400">{room.code}</span>{" "}
            — share it with your opponent
          </p>
        </div>
        <div className="text-right text-sm">
          {players.map((p) => (
            <p key={p._id} className={p.ready ? "text-emerald-400" : "text-zinc-400"}>
              {p.name} (team {p.team}){" "}
              {p.ready ? "— ready" : p.unitCount > 0 ? "— squad locked" : "— picking"}
            </p>
          ))}
          {players.length < 2 && <p className="text-zinc-500">Waiting for opponent…</p>}
        </div>
      </header>

      {roster.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-700 p-10 text-center">
          <p className="text-zinc-400">You have no units yet.</p>
          <Link
            to="/dashboard"
            className="mt-3 inline-block rounded-lg bg-emerald-600 px-5 py-2.5 font-semibold text-white transition-colors hover:bg-emerald-500 active:scale-[0.96]"
          >
            Create your units
          </Link>
          <p className="mt-2 text-xs text-zinc-500">
            Build your roster once, reuse it in every match. This room stays open.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {roster.map((unit) => {
            const index = selected.indexOf(unit._id);
            const isSelected = index >= 0;
            return (
              <button
                key={unit._id}
                onClick={() => toggle(unit._id)}
                className={`relative flex flex-col gap-3 rounded-2xl border p-4 text-left transition-colors active:scale-[0.96] ${
                  isSelected
                    ? "border-emerald-500/60 bg-emerald-500/5"
                    : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-600"
                }`}
              >
                {isSelected && (
                  <span className="absolute top-3 right-3 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white tabular-nums">
                    {index + 1}
                  </span>
                )}
                <div className="flex items-center gap-3">
                  <img
                    src={skinSprite(unit.skin ?? undefined, unit.loadout.weapon)}
                    alt=""
                    className="h-10 w-10"
                    style={{ imageRendering: "pixelated" }}
                  />
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold">{unit.name}</h3>
                    <p className="truncate font-mono text-xs text-zinc-500">{unit.model}</p>
                  </div>
                </div>
                <p className="line-clamp-2 text-xs text-zinc-400">{unit.personality}</p>
                <div className="flex items-center gap-2 opacity-70">
                  {[
                    unit.loadout.weapon,
                    unit.loadout.helmet,
                    unit.loadout.chest,
                    unit.loadout.boots,
                    unit.loadout.active,
                  ].map((slug) => (
                    <img
                      key={slug}
                      src={itemIcon(slug)}
                      alt={slug}
                      title={slug}
                      className="h-5 w-5"
                    />
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <footer className="mt-6 flex items-center gap-4">
        <button
          onClick={onReady}
          disabled={busy || selected.length !== SQUAD_SIZE}
          className="rounded-lg bg-emerald-600 px-5 py-2.5 font-semibold text-white transition-colors hover:bg-emerald-500 active:scale-[0.96] disabled:opacity-50"
        >
          Ready — let's fight
        </button>
        <p className="text-sm text-zinc-400 tabular-nums">
          {selected.length}/{SQUAD_SIZE} selected
        </p>
        <Link to="/dashboard" className="text-sm text-emerald-400 underline">
          Manage roster
        </Link>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </footer>
    </main>
  );
}
