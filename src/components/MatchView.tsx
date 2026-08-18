// The live match. Every piece of state it draws now comes from the one
// `useRoomSocket` subscription opened by `src/pages/Room.tsx`, which is why this
// component takes the socket snapshot as a prop instead of subscribing itself:
// three Convex `useQuery` calls (board, replay, team chat) collapse into one
// socket, and a second socket here would only duplicate traffic and miss frames
// while it dialled.
//
// ── THE DAMAGE POPUPS ARE WHY THE SNAPSHOT IS WHOLESALE ────────────────────
// The floating HP numbers are derived, not pushed: the effect below diffs each
// unit's `hp` against `prevHp` and turns the deltas into popups. That works only
// because `useRoomSocket` replaces the whole `units` array on every `match:state`
// frame — so a new array identity is exactly "the board changed", and the effect
// fires once per change with both the old and new numbers available. If the hook
// ever merged unit fields in place, the board would still render correctly and
// these popups would silently never appear again.
//
// ── THE BRAIN LOOP IS FIRE-AND-FORGET ─────────────────────────────────────
// `POST /api/brain/act` answers 202 immediately and the turn's outcome arrives
// over the socket like any other turn — so there is nothing to await and nothing
// to show a spinner for. The `attempted` ref stays even though the server has an
// in-flight guard: StrictMode double-fires this effect in dev, and one HTTP
// round-trip saved is better than relying on the server to dedupe a request we
// know we already sent.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import type { Match, Message, Room, Turn, Unit } from "../../shared/types";
import type { RoomSocketState } from "../hooks/useRoomSocket";
import { api, unwrap } from "../lib/eden";
import { getApiKey } from "../lib/session";
import { skinSprite } from "../lib/sprites";
import type { Popup } from "../game/BoardScene";
import PhaserBoard from "./PhaserBoard";

/**
 * `PhaserBoard` is still typed against `Doc<"matches">` / `Doc<"units">` and is
 * not ours to change. The rows are structurally the same data under different
 * type names (see `shared/types.ts`), so the adaptation is a cast at the one
 * boundary rather than a change to the board's props.
 */
type BoardProps = React.ComponentProps<typeof PhaserBoard>;

export default function MatchView({ room, socket }: { room: Room; socket: RoomSocketState }) {
  const { match, units, turns } = socket;
  const attempted = useRef<string>("");
  const lastTurn = turns[turns.length - 1];

  // Floating damage/heal numbers: diff each unit's HP between renders here,
  // then hand the deltas to the scene, which draws and animates them.
  const prevHp = useRef<Map<string, number>>(new Map());
  const [popups, setPopups] = useState<Array<Popup>>([]);
  const popupId = useRef(1);
  useEffect(() => {
    // `units` is a fresh array on every snapshot, so this runs once per board
    // change — see the header note.
    if (units.length === 0) return;
    const next = new Map<string, number>();
    const fresh: Array<Popup> = [];
    for (const u of units) {
      if (u.hp == null || !u.position) continue;
      next.set(u._id, u.hp);
      const prev = prevHp.current.get(u._id);
      if (prev !== undefined && u.hp !== prev) {
        fresh.push({ id: popupId.current++, cell: u.position, delta: u.hp - prev });
      }
    }
    if (fresh.length > 0) console.debug("[popup-probe]", JSON.stringify(fresh));
    if (prevHp.current.size > 0 && fresh.length > 0) {
      setPopups((p) => [...p, ...fresh]);
      const ids = new Set(fresh.map((f) => f.id));
      setTimeout(() => setPopups((p) => p.filter((f) => !ids.has(f.id))), 1400);
    }
    prevHp.current = next;
  }, [units]);

  // The brain loop: on every new turn, ask the backend to play. The route itself
  // checks whether the current unit is ours and answers "skipped" otherwise.
  useEffect(() => {
    if (!match || match.status !== "running" || !match.currentUnitId) return;
    const key = getApiKey();
    if (!key) return;
    const turnKey = `${match._id}:${match.turnNumber}`;
    if (attempted.current === turnKey) return; // StrictMode / re-render guard
    attempted.current = turnKey;
    // 202 and done. The result of the turn reaches us as a socket frame, not as
    // this response, so there is deliberately nothing to do with it.
    api.api.brain.act
      .post({ matchId: match._id, apiKey: key })
      .then(unwrap)
      .catch((e: unknown) => console.error("brain.act failed:", e));
  }, [match]);

  if (!match) return <p className="p-8 text-zinc-400">Loading match…</p>;
  // Pulled out of the narrowed `match` for `onForfeit` below: TypeScript does not
  // carry a narrowing into a closure, and this is nicer than re-checking.
  const matchId = match._id;
  const unitById = new Map(units.map((u) => [u._id, u]));
  const current = match.currentUnitId ? unitById.get(match.currentUnitId) : undefined;

  const smokeCells = match.effects.flatMap((e) =>
    e.kind === "smoke" && e.expiresAfterRound >= match.roundNumber ? e.cells : [],
  );

  function onForfeit() {
    if (!confirm("Forfeit the match? The other team wins.")) return;
    api.api
      .matches({ id: matchId })
      .forfeit.post()
      .then(unwrap)
      // The resulting `match:finished` frame is what redraws the header; this
      // promise only reports that the request itself failed.
      .catch((e: unknown) => console.error(e));
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-6">
      <header className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-bold">
          Room <span className="font-mono text-emerald-400">{room.code}</span>
        </h1>
        {match.status === "running" ? (
          <p className="flex items-center gap-3 text-sm text-zinc-400">
            <button
              onClick={onForfeit}
              className="rounded-md border border-zinc-800 px-2.5 py-1 text-xs text-zinc-500 transition-colors hover:border-red-500/40 hover:text-red-400 active:scale-[0.96]"
            >
              Forfeit
            </button>
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

      <TurnOrder match={match} unitById={unitById} />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="relative">
          <PhaserBoard
            {...({ match, units, smokeCells, lastTurn, popups } as unknown as BoardProps)}
          />

          {/* event ticker: the latest battle event, front and center */}
          <AnimatePresence mode="popLayout">
            {lastTurn && (
              <motion.div
                key={lastTurn._id}
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ type: "spring", duration: 0.4, bounce: 0 }}
                className="pointer-events-none absolute top-2 left-1/2 z-10 max-w-[90%] -translate-x-1/2 rounded-full border border-zinc-700 bg-zinc-950/90 px-4 py-1.5 text-xs text-zinc-200 shadow-xl"
              >
                {lastTurn.summary}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <SidePanel match={match} unitById={unitById} turns={turns} messages={socket.messages} />
      </div>
    </main>
  );
}

// Horizontal initiative tracker: who plays now, who's next.
function TurnOrder({ match, unitById }: { match: Match; unitById: Map<string, Unit> }) {
  if (match.status !== "running") return null;
  const n = match.initiative.length;
  // Rotate so the current unit comes first, preserving turn order.
  const order = Array.from(
    { length: n },
    (_, i) => match.initiative[(match.initiativeIndex + i) % n],
  );
  return (
    <div className="mb-4 flex items-center gap-2 overflow-x-auto">
      <span className="mr-1 shrink-0 text-[10px] tracking-wide text-zinc-500 uppercase">
        Turn order
      </span>
      {order.map((id, i) => {
        const u = unitById.get(id);
        if (!u) return null;
        const isCurrent = i === 0 && u.alive;
        return (
          <motion.div
            key={id}
            layout
            transition={{ type: "spring", duration: 0.5, bounce: 0 }}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border py-1 pr-3 pl-1 ${
              !u.alive
                ? "border-zinc-900 opacity-35 grayscale"
                : isCurrent
                  ? "border-amber-400/60 bg-amber-400/10"
                  : "border-zinc-800 bg-zinc-900/60"
            }`}
            title={`${u.name} — ${u.alive ? `${u.hp} HP` : "eliminated"}`}
          >
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full ${
                u.team === "a" ? "bg-sky-500/30" : "bg-rose-500/30"
              }`}
            >
              <img
                src={skinSprite(u.skin ?? undefined, u.loadout.weapon)}
                alt=""
                className="h-5 w-5"
                style={{ imageRendering: "pixelated" }}
              />
            </span>
            <span
              className={`text-xs ${isCurrent ? "font-semibold text-amber-300" : "text-zinc-300"}`}
            >
              {u.name}
            </span>
            {isCurrent && (
              <span className="ml-0.5 size-1.5 animate-pulse rounded-full bg-amber-400" />
            )}
          </motion.div>
        );
      })}
    </div>
  );
}

/**
 * Battle log and comms.
 *
 * `messages` is whatever the socket holds and is NOT filtered here. While the
 * match runs it can only ever contain this client's own team's chat — the server
 * resolves the team from the caller's `players` row and never sends the other
 * one, so there is nothing to filter. Once the match finishes the
 * `match:finished` frame replaces it with both teams' messages, which is what
 * "revealed" means below.
 */
function SidePanel({
  match,
  unitById,
  turns,
  messages,
}: {
  match: Match;
  unitById: Map<string, Unit>;
  turns: Array<Turn>;
  messages: Array<Message>;
}) {
  const finished = match.status === "finished";

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns.length, messages.length]);

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
          {turns.map((t) => (
            <div key={t._id}>
              <p>{t.summary}</p>
              {finished && t.thinking && (
                <p className="mt-0.5 text-zinc-500 italic">
                  {unitById.get(t.unitId)?.name}: “{t.thinking}”
                </p>
              )}
            </div>
          ))}
          {turns.length === 0 && <p>The battle begins…</p>}
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-zinc-800 bg-zinc-900/50">
        <h2 className="border-b border-zinc-800 px-4 py-2 text-sm font-semibold text-zinc-300">
          {finished ? "All comms (revealed)" : "Your team's comms"}
        </h2>
        <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3 text-xs">
          {messages.map((m) => {
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
