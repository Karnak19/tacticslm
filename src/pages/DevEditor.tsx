// Dev-only preview of the unit editor (no auth required). Mounted only when
// import.meta.env.DEV — see App.tsx.
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import UnitEditor, { type UnitDraft } from "../components/UnitEditor";

export default function DevEditor() {
  const items = useQuery(api.items.list);
  const [draft, setDraft] = useState<UnitDraft>({
    name: "Havoc",
    personality: "A reckless diver who lives for the flank.",
    model: "deepseek/deepseek-v4-flash",
    loadout: {
      weapon: "dagger",
      helmet: "hood",
      chest: "cloak",
      boots: "skirmishers_boots",
      active: "dash",
      consumables: ["adrenaline", "throwing_knife"],
    },
  });
  if (!items) return null;
  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
        <UnitEditor unit={draft} items={items} onChange={(p) => setDraft({ ...draft, ...p })} />
      </div>
    </main>
  );
}
