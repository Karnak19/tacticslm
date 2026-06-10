import { useState } from "react";
import type { Doc } from "../../convex/_generated/dataModel";
import { resolveStats, type ResolvedStats } from "../../convex/lib/engine";
import type { CatalogItem } from "../../convex/lib/catalog";
import { itemIcon, SKINS, skinSprite } from "../lib/sprites";

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
  skin?: string;
  loadout: Loadout;
};

export const MODEL_SUGGESTIONS = [
  "google/gemini-2.5-flash",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4.6",
  "openai/gpt-5-mini",
  "deepseek/deepseek-chat-v3.1",
];

type GearSlot = "weapon" | "helmet" | "chest" | "boots" | "active";
type AnySlot = GearSlot | "consumable" | "skin";

const SLOT_LABELS: Record<AnySlot, string> = {
  weapon: "Weapon",
  helmet: "Helmet",
  chest: "Chest",
  boots: "Boots",
  active: "Ability",
  consumable: "Consumables",
  skin: "Skin",
};

function toCatalogMap(items: Array<Doc<"items">>) {
  return new Map(items.map((i) => [i.slug, i as unknown as CatalogItem]));
}

function safeStats(loadout: Loadout, items: Array<Doc<"items">>): ResolvedStats | null {
  try {
    return resolveStats(loadout, toCatalogMap(items));
  } catch {
    return null;
  }
}

export default function UnitEditor({
  unit,
  items,
  onChange,
}: {
  unit: UnitDraft;
  items: Array<Doc<"items">>;
  onChange: (patch: Partial<UnitDraft>) => void;
}) {
  const [activeSlot, setActiveSlot] = useState<AnySlot>("weapon");
  const [hovered, setHovered] = useState<Doc<"items"> | null>(null);

  const stats = safeStats(unit.loadout, items);
  // Preview: stats if the hovered item were equipped.
  const previewStats =
    hovered && hovered.slot !== "consumable"
      ? safeStats({ ...unit.loadout, [hovered.slot]: hovered.slug }, items)
      : null;

  function updateLoadout(patch: Partial<Loadout>) {
    onChange({ loadout: { ...unit.loadout, ...patch } });
  }

  function equip(item: Doc<"items">) {
    if (item.slot === "consumable") {
      const has = unit.loadout.consumables.includes(item.slug);
      const next = has
        ? unit.loadout.consumables.filter((s) => s !== item.slug)
        : [...unit.loadout.consumables, item.slug].slice(-2);
      updateLoadout({ consumables: next });
    } else {
      updateLoadout({ [item.slot]: item.slug });
    }
  }

  const detail = hovered;

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      {/* ── Left: the character ── */}
      <div className="flex flex-col gap-4">
        <input
          value={unit.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Unit name"
          className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-lg font-semibold outline-none focus:border-zinc-600"
        />

        <Doll
          loadout={unit.loadout}
          skin={unit.skin}
          activeSlot={activeSlot}
          onSelectSlot={(s) => {
            setActiveSlot(s);
            setHovered(null);
            document
              .getElementById(`inv-${s}`)
              ?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        />

        {stats && <StatBlock stats={stats} preview={previewStats} />}

        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Personality (this is the soul of your unit)
          <textarea
            value={unit.personality}
            onChange={(e) => onChange({ personality: e.target.value })}
            rows={4}
            placeholder="The Arrogant Leader. Never retreats, claims every kill, blames Whisper for everything…"
            className="resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-600"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Brain (OpenRouter model id)
          <input
            value={unit.model}
            onChange={(e) => onChange({ model: e.target.value })}
            list="model-suggestions"
            className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm outline-none focus:border-zinc-600"
          />
        </label>
        <datalist id="model-suggestions">
          {MODEL_SUGGESTIONS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>

      {/* ── Right: the full inventory, grouped by category ── */}
      <div className="flex min-h-0 flex-col gap-5">
        <SkinGroup unit={unit} onChange={onChange} />

        {(["weapon", "helmet", "chest", "boots", "active", "consumable"] as const).map((slot) => (
          <div key={slot} id={`inv-${slot}`}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-300">{SLOT_LABELS[slot]}</h3>
              {slot === "consumable" && (
                <span className="text-xs text-zinc-500 tabular-nums">
                  {unit.loadout.consumables.length}/2 equipped
                </span>
              )}
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(56px,1fr))] gap-2">
              {items
                .filter((i) => i.slot === slot)
                .map((item) => {
                  const equipped =
                    item.slot === "consumable"
                      ? unit.loadout.consumables.includes(item.slug)
                      : currentSlug(unit.loadout, item.slot as AnySlot) === item.slug;
                  return (
                    <button
                      key={item.slug}
                      onClick={() => equip(item)}
                      onMouseEnter={() => setHovered(item)}
                      onMouseLeave={() => setHovered(null)}
                      className={`flex aspect-square items-center justify-center rounded-xl border transition-colors active:scale-[0.96] ${
                        equipped
                          ? "border-emerald-500/70 bg-emerald-500/10"
                          : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-600"
                      }`}
                      title={item.name}
                    >
                      <img
                        src={itemIcon(item.slug)}
                        alt={item.name}
                        className="h-8 w-8 opacity-90"
                      />
                    </button>
                  );
                })}
            </div>
          </div>
        ))}

        {/* item detail card — sticky so it's visible while browsing */}
        <div className="sticky bottom-4">
          {detail && (
            <div className="rounded-xl border border-zinc-700 bg-zinc-950 p-4 shadow-2xl shadow-black/50">
              <div className="flex items-center gap-3">
                <img src={itemIcon(detail.slug)} alt="" className="h-9 w-9" />
                <div>
                  <p className="font-semibold">{detail.name}</p>
                  <p className="text-xs text-zinc-500 capitalize">{detail.slot}</p>
                </div>
              </div>
              <p className="mt-2 text-sm text-zinc-400" style={{ textWrap: "pretty" }}>
                {detail.description}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Skin row: always visible at the top of the inventory.
function SkinGroup({
  unit,
  onChange,
}: {
  unit: UnitDraft;
  onChange: (patch: Partial<UnitDraft>) => void;
}) {
  return (
    <div id="inv-skin">
      <h3 className="mb-2 text-sm font-semibold text-zinc-300">Skin</h3>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(56px,1fr))] gap-2">
        {SKINS.map((s) => {
          const equipped = skinSprite(unit.skin, unit.loadout.weapon) === s.src;
          return (
            <button
              key={s.slug}
              onClick={() => onChange({ skin: s.slug })}
              className={`flex aspect-square items-center justify-center rounded-xl border transition-colors active:scale-[0.96] ${
                equipped
                  ? "border-emerald-500/70 bg-emerald-500/10"
                  : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-600"
              }`}
              title={s.name}
            >
              <img
                src={s.src}
                alt={s.name}
                className="h-9 w-9"
                style={{ imageRendering: "pixelated" }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function currentSlug(loadout: Loadout, slot: AnySlot): string | undefined {
  return slot === "consumable" || slot === "skin" ? undefined : loadout[slot];
}

// RPG-style equipment doll: slots arranged around the character sprite.
function Doll({
  loadout,
  skin,
  activeSlot,
  onSelectSlot,
}: {
  loadout: Loadout;
  skin?: string;
  activeSlot: AnySlot;
  onSelectSlot: (slot: AnySlot) => void;
}) {
  const slot = (s: AnySlot, slug?: string) => (
    <SlotButton
      key={s}
      slot={s}
      slug={slug}
      active={activeSlot === s}
      onClick={() => onSelectSlot(s)}
    />
  );

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="grid grid-cols-3 items-center justify-items-center gap-2">
        <div />
        {slot("helmet", loadout.helmet)}
        <div />

        {slot("weapon", loadout.weapon)}
        <button
          onClick={() => onSelectSlot("skin")}
          title="Skin"
          className={`flex h-24 w-24 items-center justify-center rounded-xl bg-zinc-950 transition-colors active:scale-[0.96] ${
            activeSlot === "skin"
              ? "ring-2 ring-emerald-500/70"
              : "hover:ring-2 hover:ring-zinc-700"
          }`}
        >
          <img
            src={skinSprite(skin, loadout.weapon)}
            alt=""
            className="h-20 w-20"
            style={{ imageRendering: "pixelated" }}
          />
        </button>
        {slot("chest", loadout.chest)}

        {slot("active", loadout.active)}
        {slot("boots", loadout.boots)}
        <ConsumablesSlot
          slugs={loadout.consumables}
          active={activeSlot === "consumable"}
          onClick={() => onSelectSlot("consumable")}
        />
      </div>
    </div>
  );
}

function SlotButton({
  slot,
  slug,
  active,
  onClick,
}: {
  slot: AnySlot;
  slug?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-xl border transition-colors active:scale-[0.96] ${
        active
          ? "border-emerald-500/70 bg-emerald-500/10"
          : "border-zinc-800 bg-zinc-950 hover:border-zinc-600"
      }`}
      title={SLOT_LABELS[slot]}
    >
      {slug ? (
        <img src={itemIcon(slug)} alt="" className="h-7 w-7 opacity-90" />
      ) : (
        <span className="text-lg text-zinc-700">?</span>
      )}
      <span className="text-[0.55rem] text-zinc-500">{SLOT_LABELS[slot]}</span>
    </button>
  );
}

function ConsumablesSlot({
  slugs,
  active,
  onClick,
}: {
  slugs: Array<string>;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-xl border transition-colors active:scale-[0.96] ${
        active
          ? "border-emerald-500/70 bg-emerald-500/10"
          : "border-zinc-800 bg-zinc-950 hover:border-zinc-600"
      }`}
      title="Consumables"
    >
      <span className="flex gap-0.5">
        {slugs.length > 0 ? (
          slugs.map((s) => <img key={s} src={itemIcon(s)} alt="" className="h-5 w-5 opacity-90" />)
        ) : (
          <span className="text-lg text-zinc-700">?</span>
        )}
      </span>
      <span className="text-[0.55rem] text-zinc-500">Items</span>
    </button>
  );
}

// Stat block with hover-preview deltas (video-game style green/red arrows).
function StatBlock({ stats, preview }: { stats: ResolvedStats; preview: ResolvedStats | null }) {
  const rows: Array<[string, number, number | undefined]> = [
    ["HP", stats.maxHp, preview?.maxHp],
    ["Move", stats.move, preview?.move],
    ["Speed", stats.speed, preview?.speed],
    ["Damage", stats.damage, preview?.damage],
    ["Range", stats.attackRange, preview?.attackRange],
  ];
  return (
    <div className="grid grid-cols-5 gap-1.5">
      {rows.map(([label, value, next]) => {
        const delta = next !== undefined ? next - value : 0;
        return (
          <div
            key={label}
            className="rounded-lg border border-zinc-800 bg-zinc-950 px-1.5 py-1.5 text-center"
          >
            <p className="text-[0.6rem] text-zinc-500">{label}</p>
            <p className="font-mono text-sm font-semibold text-zinc-200 tabular-nums">
              {next !== undefined && delta !== 0 ? next : value}
            </p>
            <p
              className={`h-3 font-mono text-[0.6rem] tabular-nums ${
                delta > 0 ? "text-emerald-400" : delta < 0 ? "text-red-400" : "text-transparent"
              }`}
            >
              {delta > 0 ? `▲${delta}` : delta < 0 ? `▼${-delta}` : "·"}
            </p>
          </div>
        );
      })}
    </div>
  );
}
