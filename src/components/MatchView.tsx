import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { getApiKey } from "../lib/session";

export default function MatchView({ room }: { room: Doc<"rooms"> }) {
  const data = useQuery(api.matches.byRoom, { roomId: room._id });
  const act = useAction(api.brain.act);
  const attempted = useRef<string>("");

  const match = data?.match;

  // The brain loop: on every new turn, ask the backend to play. The action
  // itself checks whether the current unit is ours and no-ops otherwise.
  useEffect(() => {
    if (!match || match.status !== "running" || !match.currentUnitId) return;
    const key = getApiKey();
    if (!key) return;
    const turnKey = `${match._id}:${match.turnNumber}`;
    if (attempted.current === turnKey) return; // StrictMode / re-render guard
    attempted.current = turnKey;
    act({ matchId: match._id, apiKey: key }).catch((e) => console.error("brain.act failed:", e));
  }, [match, act]);

  if (!data || !match) return <p className="p-8 text-zinc-400">Loading match…</p>;
  const { units } = data;
  const unitById = new Map(units.map((u) => [u._id as string, u]));
  const current = match.currentUnitId ? unitById.get(match.currentUnitId) : undefined;

  const smokeCells = match.effects.flatMap((e) =>
    e.kind === "smoke" && e.expiresAfterRound >= match.roundNumber ? e.cells : [],
  );

  return (
    <main className="mx-auto max-w-6xl px-6 py-6">
      <header className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-bold">
          Room <span className="font-mono text-emerald-400">{room.code}</span>
        </h1>
        {match.status === "running" ? (
          <p className="text-sm text-zinc-400">
            Round {match.roundNumber}/{match.turnCap} —{" "}
            {current ? (
              <>
                <span className={current.team === "a" ? "text-sky-400" : "text-rose-400"}>
                  {current.name}
                </span>{" "}
                is thinking…
              </>
            ) : (
              "…"
            )}
          </p>
        ) : (
          <p className="text-lg font-semibold text-emerald-400">
            {match.winnerTeam === "draw"
              ? "Draw!"
              : `Team ${match.winnerTeam?.toUpperCase()} wins!`}{" "}
            <Link to="/" className="ml-2 text-sm text-zinc-400 underline">
              New game
            </Link>
          </p>
        )}
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Board match={match} units={units} smokeCells={smokeCells} />
        <SidePanel match={match} unitById={unitById} />
      </div>
    </main>
  );
}

function Board({
  match,
  units,
  smokeCells,
}: {
  match: Doc<"matches">;
  units: Array<Doc<"units">>;
  smokeCells: Array<{ x: number; y: number }>;
}) {
  const n = match.gridSize;
  const wallSet = new Set(match.walls.map((w) => `${w.x},${w.y}`));
  const smokeSet = new Set(smokeCells.map((c) => `${c.x},${c.y}`));
  const cell = 100 / n;

  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      {/* static cells */}
      <div
        className="absolute inset-0 grid"
        style={{ gridTemplateColumns: `repeat(${n}, 1fr)`, gridTemplateRows: `repeat(${n}, 1fr)` }}
      >
        {Array.from({ length: n * n }, (_, idx) => {
          const x = idx % n;
          const y = Math.floor(idx / n);
          const isWall = wallSet.has(`${x},${y}`);
          const isSmoke = smokeSet.has(`${x},${y}`);
          return (
            <div
              key={idx}
              className={
                isWall
                  ? "bg-zinc-700"
                  : isSmoke
                    ? "bg-zinc-500/40"
                    : (x + y) % 2 === 0
                      ? "bg-zinc-900"
                      : "bg-zinc-900/50"
              }
              style={{ boxShadow: "inset 0 0 0 0.5px rgb(39 39 42 / 0.6)" }}
            />
          );
        })}
      </div>

      {/* units */}
      {units.map((u) => {
        if (!u.position || !u.alive) return null;
        const isCurrent = match.currentUnitId === u._id;
        return (
          <motion.div
            key={u._id}
            className="absolute flex items-center justify-center"
            style={{ width: `${cell}%`, height: `${cell}%` }}
            initial={false}
            animate={{ left: `${u.position.x * cell}%`, top: `${u.position.y * cell}%` }}
            transition={{ type: "spring", stiffness: 200, damping: 25 }}
          >
            <div
              className={`relative flex h-4/5 w-4/5 items-center justify-center rounded-full text-[0.6rem] font-bold text-white ${
                u.team === "a" ? "bg-sky-600" : "bg-rose-600"
              } ${isCurrent ? "ring-2 ring-amber-400" : ""}`}
              title={`${u.name} — ${u.hp} HP`}
            >
              {u.name.slice(0, 2).toUpperCase()}
              <span className="absolute -bottom-1 left-1/2 h-1 w-4/5 -translate-x-1/2 overflow-hidden rounded bg-zinc-950/80">
                <span
                  className="block h-full bg-emerald-400"
                  style={{ width: `${Math.max(0, Math.min(100, ((u.hp ?? 0) / 33) * 100))}%` }}
                />
              </span>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

function SidePanel({
  match,
  unitById,
}: {
  match: Doc<"matches">;
  unitById: Map<string, Doc<"units">>;
}) {
  const chat = useQuery(api.matches.teamMessages, { matchId: match._id });
  const replay = useQuery(api.matches.replay, { matchId: match._id });
  const finished = match.status === "finished";

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [replay?.turns.length, chat?.length]);

  return (
    <aside className="flex max-h-[80vh] flex-col gap-4">
      <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-zinc-800 bg-zinc-900/50">
        <h2 className="border-b border-zinc-800 px-4 py-2 text-sm font-semibold text-zinc-300">
          Battle log
        </h2>
        <div
          ref={logRef}
          className="flex-1 space-y-2 overflow-y-auto px-4 py-3 text-xs text-zinc-400"
        >
          {replay?.turns.map((t) => (
            <div key={t._id}>
              <p>{t.summary}</p>
              {finished && t.thinking && (
                <p className="mt-0.5 text-zinc-500 italic">
                  {unitById.get(t.unitId)?.name}: “{t.thinking}”
                </p>
              )}
            </div>
          ))}
          {!replay?.turns.length && <p>The battle begins…</p>}
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-zinc-800 bg-zinc-900/50">
        <h2 className="border-b border-zinc-800 px-4 py-2 text-sm font-semibold text-zinc-300">
          {finished ? "All comms (revealed)" : "Your team's comms"}
        </h2>
        <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3 text-xs">
          {(finished ? (replay?.messages ?? []) : (chat ?? [])).map((m) => {
            const unit = unitById.get(m.unitId);
            return (
              <p key={m._id}>
                <span
                  className={`font-semibold ${unit?.team === "a" ? "text-sky-400" : "text-rose-400"}`}
                >
                  {unit?.name ?? "?"}:
                </span>{" "}
                <span className="text-zinc-300">{m.text}</span>
              </p>
            );
          })}
        </div>
      </section>
    </aside>
  );
}
