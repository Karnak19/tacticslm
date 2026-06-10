import { useState } from "react";
import { Link } from "react-router-dom";
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "convex/react";
import { SignInButton, UserButton } from "@clerk/clerk-react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import UnitEditor, { type UnitDraft } from "../components/UnitEditor";
import { itemIcon, unitSprite } from "../lib/sprites";

const NEW_UNIT: UnitDraft = {
  name: "New Unit",
  personality: "",
  model: "google/gemini-2.5-flash",
  loadout: {
    weapon: "sword",
    helmet: "great_helm",
    chest: "leather",
    boots: "swiftboots",
    active: "heal_pulse",
    consumables: ["health_potion", "throwing_knife"],
  },
};

export default function Dashboard() {
  return (
    <>
      <AuthLoading>
        <Centered>Loading…</Centered>
      </AuthLoading>
      <Unauthenticated>
        <Centered>
          <span className="mr-3">Sign in to manage your units.</span>
          <SignInButton mode="modal">
            <button className="rounded-lg bg-emerald-600 px-4 py-2 font-semibold text-white active:scale-[0.96]">
              Sign in
            </button>
          </SignInButton>
        </Centered>
      </Unauthenticated>
      <Authenticated>
        <DashboardInner />
      </Authenticated>
    </>
  );
}

function DashboardInner() {
  const roster = useQuery(api.roster.list);
  const items = useQuery(api.items.list);
  const save = useMutation(api.roster.save);
  const remove = useMutation(api.roster.remove);

  // null = nothing open; "new" = creating; otherwise editing that roster id
  const [editing, setEditing] = useState<"new" | Id<"rosterUnits"> | null>(null);
  const [draft, setDraft] = useState<UnitDraft>(NEW_UNIT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!roster || !items) return <Centered>Loading…</Centered>;

  function openNew() {
    setDraft(NEW_UNIT);
    setEditing("new");
    setError(null);
  }

  function openEdit(unit: Doc<"rosterUnits">) {
    setDraft({
      name: unit.name,
      personality: unit.personality,
      model: unit.model,
      loadout: unit.loadout,
    });
    setEditing(unit._id);
    setError(null);
  }

  async function onSave() {
    setError(null);
    if (!draft.name.trim()) {
      setError("Give your unit a name.");
      return;
    }
    if (!draft.personality.trim()) {
      setError("Write a personality — it's the whole point!");
      return;
    }
    setBusy(true);
    try {
      await save({ id: editing === "new" ? undefined : (editing ?? undefined), ...draft });
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: Id<"rosterUnits">) {
    await remove({ id });
    if (editing === id) setEditing(null);
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Your units</h1>
          <p className="text-sm text-zinc-400">
            Build them here, deploy them in any room.{" "}
            <Link to="/" className="text-emerald-400 underline">
              Home
            </Link>
          </p>
        </div>
        <UserButton />
      </header>

      <div className={`grid gap-8 ${editing ? "lg:grid-cols-[1fr_380px]" : ""}`}>
        <section>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <button
              onClick={openNew}
              className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-zinc-700 text-zinc-500 transition-colors hover:border-emerald-500/50 hover:text-emerald-400 active:scale-[0.96]"
            >
              <span className="text-3xl leading-none">+</span>
              <span className="text-sm font-semibold">New unit</span>
            </button>

            {roster.map((unit) => (
              <article
                key={unit._id}
                className={`flex flex-col gap-3 rounded-2xl border bg-zinc-900/40 p-4 ${
                  editing === unit._id ? "border-emerald-500/50" : "border-zinc-800"
                }`}
              >
                <div className="flex items-center gap-3">
                  <img
                    src={unitSprite(unit.loadout.weapon)}
                    alt=""
                    className="h-10 w-10"
                    style={{ imageRendering: "pixelated" }}
                  />
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold">{unit.name}</h3>
                    <p className="truncate font-mono text-xs text-zinc-500">{unit.model}</p>
                  </div>
                </div>
                <p className="line-clamp-2 text-xs text-zinc-400" style={{ textWrap: "pretty" }}>
                  {unit.personality}
                </p>
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
                <div className="mt-auto flex gap-2">
                  <button
                    onClick={() => openEdit(unit)}
                    className="flex-1 rounded-lg bg-zinc-800 px-3 py-1.5 text-sm font-semibold transition-colors hover:bg-zinc-700 active:scale-[0.96]"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onDelete(unit._id)}
                    className="rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:border-red-500/40 hover:text-red-400 active:scale-[0.96]"
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
          {roster.length === 0 && (
            <p className="mt-6 text-sm text-zinc-500">
              No units yet. Create your first brain — give it a personality it can't escape.
            </p>
          )}
        </section>

        {editing && (
          <aside className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">{editing === "new" ? "New unit" : "Edit unit"}</h2>
              <button
                onClick={() => setEditing(null)}
                className="text-sm text-zinc-500 hover:text-zinc-300"
              >
                Close
              </button>
            </div>
            <UnitEditor unit={draft} items={items} onChange={(p) => setDraft({ ...draft, ...p })} />
            <button
              onClick={onSave}
              disabled={busy}
              className="mt-4 w-full rounded-lg bg-emerald-600 px-4 py-2.5 font-semibold text-white transition-colors hover:bg-emerald-500 active:scale-[0.96] disabled:opacity-50"
            >
              {editing === "new" ? "Create unit" : "Save changes"}
            </button>
            {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
          </aside>
        )}
      </div>
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center text-zinc-400">
      <p>{children}</p>
    </div>
  );
}
