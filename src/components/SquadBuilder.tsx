import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { itemIcon, unitSprite } from "../lib/sprites";

type Loadout = {
  weapon: string;
  helmet: string;
  chest: string;
  boots: string;
  active: string;
  consumables: Array<string>;
};

type UnitDraft = {
  name: string;
  personality: string;
  model: string;
  loadout: Loadout;
};

const DEFAULT_SQUAD: Array<UnitDraft> = [
  {
    name: "Bastion",
    personality:
      "A stoic veteran who leads from the front. Protects teammates, calls targets, never panics.",
    model: "google/gemini-2.5-flash",
    loadout: {
      weapon: "sword",
      helmet: "great_helm",
      chest: "plate",
      boots: "greaves",
      active: "taunt",
      consumables: ["health_potion", "adrenaline"],
    },
  },
  {
    name: "Whisper",
    personality:
      "An anxious but brilliant support. Keeps distance, heals allies, warns about threats constantly.",
    model: "google/gemini-2.5-flash",
    loadout: {
      weapon: "bow",
      helmet: "strategists_circlet",
      chest: "leather",
      boots: "swiftboots",
      active: "heal_pulse",
      consumables: ["health_potion", "throwing_knife"],
    },
  },
  {
    name: "Havoc",
    personality:
      "A reckless diver who lives for the flank. Overconfident, ignores caution, loves explosions.",
    model: "google/gemini-2.5-flash",
    loadout: {
      weapon: "dagger",
      helmet: "hood",
      chest: "cloak",
      boots: "skirmishers_boots",
      active: "dash",
      consumables: ["adrenaline", "throwing_knife"],
    },
  },
];

const MODEL_SUGGESTIONS = [
  "google/gemini-2.5-flash",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4.6",
  "openai/gpt-5-mini",
  "deepseek/deepseek-chat-v3.1",
];

type LobbyData = {
  room: Doc<"rooms">;
  players: Array<{
    _id: Id<"players">;
    name: string;
    team: "a" | "b";
    ready: boolean;
    unitCount: number;
  }>;
};

export default function SquadBuilder({ room, lobby }: { room: Doc<"rooms">; lobby: LobbyData }) {
  const items = useQuery(api.items.list);
  const roster = useQuery(api.roster.list);
  const setSquad = useMutation(api.rooms.setSquad);
  const setReady = useMutation(api.rooms.setReady);
  const saveToRoster = useMutation(api.roster.save);
  const [squad, setSquadState] = useState<Array<UnitDraft>>(DEFAULT_SQUAD);
  const [saved, setSaved] = useState(false);
  const [rosterSaved, setRosterSaved] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!items) return <p className="p-8 text-zinc-400">Loading catalog…</p>;
  const bySlot = (slot: string) => items.filter((i) => i.slot === slot);

  function updateUnit(index: number, patch: Partial<UnitDraft>) {
    setSquadState((prev) => prev.map((u, i) => (i === index ? { ...u, ...patch } : u)));
    setSaved(false);
    setRosterSaved((prev) => ({ ...prev, [index]: false }));
  }

  function updateLoadout(index: number, patch: Partial<Loadout>) {
    setSquadState((prev) =>
      prev.map((u, i) => (i === index ? { ...u, loadout: { ...u.loadout, ...patch } } : u)),
    );
    setSaved(false);
    setRosterSaved((prev) => ({ ...prev, [index]: false }));
  }

  function loadFromRoster(index: number, rosterId: string) {
    const unit = roster?.find((r) => r._id === rosterId);
    if (!unit) return;
    updateUnit(index, {
      name: unit.name,
      personality: unit.personality,
      model: unit.model,
      loadout: unit.loadout,
    });
  }

  async function onSaveToRoster(index: number) {
    setError(null);
    try {
      const u = squad[index];
      // Upsert by name: same-named roster unit gets overwritten.
      const existing = roster?.find((r) => r.name === u.name);
      await saveToRoster({ id: existing?._id, ...u });
      setRosterSaved((prev) => ({ ...prev, [index]: true }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onSave() {
    setError(null);
    setBusy(true);
    try {
      await setSquad({ roomId: room._id, squad });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onReady() {
    setError(null);
    setBusy(true);
    try {
      if (!saved) await setSquad({ roomId: room._id, squad });
      setSaved(true);
      await setReady({ roomId: room._id, ready: true });
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
          <h1 className="text-2xl font-bold">Build your squad</h1>
          <p className="text-sm text-zinc-400">
            Room code:{" "}
            <span className="font-mono text-lg tracking-widest text-emerald-400">{room.code}</span>{" "}
            — share it with your opponent
          </p>
        </div>
        <div className="text-right text-sm">
          {lobby.players.map((p) => (
            <p key={p._id} className={p.ready ? "text-emerald-400" : "text-zinc-400"}>
              {p.name} (team {p.team}){" "}
              {p.ready ? "— ready" : p.unitCount > 0 ? "— building" : "— joined"}
            </p>
          ))}
          {lobby.players.length < 2 && <p className="text-zinc-500">Waiting for opponent…</p>}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        {squad.map((unit, i) => (
          <section
            key={i}
            className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"
          >
            {(roster?.length ?? 0) > 0 && (
              <select
                value=""
                onChange={(e) => loadFromRoster(i, e.target.value)}
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400 outline-none"
              >
                <option value="">Load from roster…</option>
                {roster!.map((r) => (
                  <option key={r._id} value={r._id}>
                    {r.name} ({r.model})
                  </option>
                ))}
              </select>
            )}
            <div className="flex items-center gap-2">
              <img
                src={unitSprite(unit.loadout.weapon)}
                alt=""
                className="h-10 w-10"
                style={{ imageRendering: "pixelated" }}
              />
              <input
                value={unit.name}
                onChange={(e) => updateUnit(i, { name: e.target.value })}
                className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-lg font-semibold outline-none focus:border-zinc-600"
              />
            </div>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Personality (this is the soul of your unit)
              <textarea
                value={unit.personality}
                onChange={(e) => updateUnit(i, { personality: e.target.value })}
                rows={4}
                className="resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-600"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Model (OpenRouter id)
              <input
                value={unit.model}
                onChange={(e) => updateUnit(i, { model: e.target.value })}
                list="model-suggestions"
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm outline-none focus:border-zinc-600"
              />
            </label>

            {(["weapon", "helmet", "chest", "boots", "active"] as const).map((slot) => (
              <label key={slot} className="flex flex-col gap-1 text-xs text-zinc-400">
                {slot[0].toUpperCase() + slot.slice(1)}
                <div className="flex items-center gap-2">
                  <img
                    src={itemIcon(unit.loadout[slot])}
                    alt=""
                    className="h-7 w-7 shrink-0 opacity-80"
                  />
                  <select
                    value={unit.loadout[slot]}
                    onChange={(e) => updateLoadout(i, { [slot]: e.target.value })}
                    className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-600"
                  >
                    {bySlot(slot).map((item) => (
                      <option key={item.slug} value={item.slug}>
                        {item.name} — {item.description}
                      </option>
                    ))}
                  </select>
                </div>
              </label>
            ))}

            <fieldset className="flex flex-col gap-1 text-xs text-zinc-400">
              Consumables (pick 2)
              {bySlot("consumable").map((item) => {
                const checked = unit.loadout.consumables.includes(item.slug);
                return (
                  <label key={item.slug} className="flex items-center gap-2 text-sm text-zinc-300">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? unit.loadout.consumables.filter((s) => s !== item.slug)
                          : [...unit.loadout.consumables, item.slug].slice(-2);
                        updateLoadout(i, { consumables: next });
                      }}
                    />
                    <img src={itemIcon(item.slug)} alt="" className="h-5 w-5 opacity-80" />
                    {item.name}
                  </label>
                );
              })}
            </fieldset>

            <button
              onClick={() => onSaveToRoster(i)}
              className="mt-1 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800"
            >
              {rosterSaved[i] ? "Saved to roster ✓" : "Save to roster"}
            </button>
          </section>
        ))}
      </div>

      <datalist id="model-suggestions">
        {MODEL_SUGGESTIONS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <footer className="mt-6 flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={busy}
          className="rounded-lg bg-zinc-800 px-5 py-2.5 font-semibold transition hover:bg-zinc-700 disabled:opacity-50"
        >
          {saved ? "Saved ✓" : "Save squad"}
        </button>
        <button
          onClick={onReady}
          disabled={busy}
          className="rounded-lg bg-emerald-600 px-5 py-2.5 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
        >
          Ready — let's fight
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </footer>
    </main>
  );
}
