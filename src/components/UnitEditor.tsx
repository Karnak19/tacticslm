import type { Doc } from "../../convex/_generated/dataModel";
import { resolveStats } from "../../convex/lib/engine";
import type { CatalogItem } from "../../convex/lib/catalog";
import { itemIcon, unitSprite } from "../lib/sprites";

export type Loadout = {
  weapon: string;
  helmet: string;
  chest: string;
  boots: string;
  active: string;
  consumables: Array<string>;
};

export type UnitDraft = {
  name: string;
  personality: string;
  model: string;
  loadout: Loadout;
};

export const MODEL_SUGGESTIONS = [
  "google/gemini-2.5-flash",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4.6",
  "openai/gpt-5-mini",
  "deepseek/deepseek-chat-v3.1",
];

export const SLOTS = ["weapon", "helmet", "chest", "boots", "active"] as const;

export default function UnitEditor({
  unit,
  items,
  onChange,
}: {
  unit: UnitDraft;
  items: Array<Doc<"items">>;
  onChange: (patch: Partial<UnitDraft>) => void;
}) {
  const bySlot = (slot: string) => items.filter((i) => i.slot === slot);

  function updateLoadout(patch: Partial<Loadout>) {
    onChange({ loadout: { ...unit.loadout, ...patch } });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <img
          src={unitSprite(unit.loadout.weapon)}
          alt=""
          className="h-10 w-10"
          style={{ imageRendering: "pixelated" }}
        />
        <input
          value={unit.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Unit name"
          className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-lg font-semibold outline-none focus:border-zinc-600"
        />
      </div>

      <StatsPreview loadout={unit.loadout} items={items} />

      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        Personality (this is the soul of your unit)
        <textarea
          value={unit.personality}
          onChange={(e) => onChange({ personality: e.target.value })}
          rows={4}
          className="resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-600"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        Model (OpenRouter id)
        <input
          value={unit.model}
          onChange={(e) => onChange({ model: e.target.value })}
          list="model-suggestions"
          className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm outline-none focus:border-zinc-600"
        />
      </label>

      {SLOTS.map((slot) => (
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
              onChange={(e) => updateLoadout({ [slot]: e.target.value })}
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
                  updateLoadout({ consumables: next });
                }}
              />
              <img src={itemIcon(item.slug)} alt="" className="h-5 w-5 opacity-80" />
              {item.name}
            </label>
          );
        })}
      </fieldset>

      <datalist id="model-suggestions">
        {MODEL_SUGGESTIONS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  );
}

// Live stat preview computed by the real game engine.
function StatsPreview({ loadout, items }: { loadout: Loadout; items: Array<Doc<"items">> }) {
  let stats;
  try {
    const catalog = new Map(items.map((i) => [i.slug, i as unknown as CatalogItem]));
    stats = resolveStats(loadout, catalog);
  } catch {
    return null;
  }
  const entries: Array<[string, string | number]> = [
    ["HP", stats.maxHp],
    ["Move", stats.move],
    ["Speed", stats.speed],
    ["Dmg", stats.damage],
    ["Range", stats.attackRange],
  ];
  return (
    <div className="flex gap-2">
      {entries.map(([label, value]) => (
        <div
          key={label}
          className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-center"
        >
          <p className="text-[0.65rem] text-zinc-500">{label}</p>
          <p className="font-mono text-sm font-semibold text-zinc-200 tabular-nums">{value}</p>
        </div>
      ))}
    </div>
  );
}
