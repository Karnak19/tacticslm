// Dev-only preview of the unit editor (no auth required). Mounted only when
// import.meta.env.DEV — see App.tsx. It talks to no backend at all: the item
// catalog is a constant the editor imports for itself.
import { useState } from "react";
import UnitEditor, { type UnitDraft } from "../components/UnitEditor";

export default function DevEditor() {
  const [draft, setDraft] = useState<UnitDraft>({
    name: "Havoc",
    personality: "A reckless diver who lives for the flank.",
    model: "nvidia/nemotron-3.5-lightning",
    loadout: {
      weapon: "dagger",
      helmet: "hood",
      chest: "cloak",
      boots: "skirmishers_boots",
      active: "dash",
      consumables: ["adrenaline", "throwing_knife"],
    },
  });
  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
        <UnitEditor unit={draft} onChange={(p) => setDraft({ ...draft, ...p })} />
      </div>
    </main>
  );
}
