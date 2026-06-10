import { useState } from "react";
import { Link } from "react-router-dom";
import { Authenticated, Unauthenticated } from "convex/react";
import { SignInButton, UserButton } from "@clerk/clerk-react";
import { ChevronDownIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { getApiKey, setApiKey } from "../lib/session";
import { skinSprite } from "../lib/sprites";

function maskKey(k: string): string {
  if (!k) return "no key";
  return `•••• ${k.slice(-4)}`;
}

// Navbar chip showing OpenRouter key status; click to edit. The key only
// lives in localStorage and is sent per-call to the backend, never stored.
function NavKey() {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(getApiKey());
  const [draft, setDraft] = useState(getApiKey());
  const empty = !key;

  function save() {
    const trimmed = draft.trim();
    setApiKey(trimmed);
    setKey(trimmed);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="OpenRouter key"
          className={`group inline-flex h-8 items-center gap-2 rounded-full border px-2.5 font-mono text-xs transition-colors ${
            empty
              ? "border-red-500/45 bg-red-500/10 text-red-400 hover:bg-red-500/15"
              : "border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
          }`}
        >
          <span
            className={`size-1.5 rounded-full ring-3 ${
              empty
                ? "animate-pulse bg-red-500 ring-red-500/20"
                : "bg-emerald-400 ring-emerald-400/20"
            }`}
          />
          <span className="hidden text-[10px] tracking-wide text-zinc-500 uppercase sm:inline">
            key
          </span>
          <span>{maskKey(key)}</span>
          <ChevronDownIcon className="size-3 text-zinc-500 transition-transform group-aria-expanded:rotate-180" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={10} className="w-80">
        <p className="mb-1 text-sm font-semibold">OpenRouter key</p>
        <p className="mb-3 text-xs text-zinc-500">
          Stays in your browser. Powers your own units and the coach.{" "}
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noreferrer"
            className="text-emerald-400 underline"
          >
            Get one
          </a>
        </p>
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            type="password"
            placeholder="sk-or-…"
            className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm outline-none focus:border-zinc-600"
          />
          <button
            onClick={save}
            className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 active:scale-[0.96]"
          >
            Save
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function SiteNav() {
  return (
    <nav className="relative mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
      <Link to="/" className="flex items-center gap-2">
        <img
          src={skinSprite(undefined, "sword")}
          alt=""
          className="h-7 w-7"
          style={{ imageRendering: "pixelated" }}
        />
        <span className="font-bold tracking-tight">TacticsLM</span>
      </Link>
      <div className="flex items-center gap-4">
        <Authenticated>
          <Link
            to="/dashboard"
            className="text-sm text-zinc-400 transition-colors hover:text-zinc-100"
          >
            My units
          </Link>
        </Authenticated>
        <a
          href="https://github.com/Karnak19/tacticslm"
          target="_blank"
          rel="noreferrer"
          className="text-sm text-zinc-400 transition-colors hover:text-zinc-100"
        >
          GitHub
        </a>
        <NavKey />
        <Authenticated>
          <UserButton />
        </Authenticated>
        <Unauthenticated>
          <SignInButton mode="modal">
            <button className="rounded-lg bg-zinc-800 px-4 py-2 text-sm font-semibold transition-colors hover:bg-zinc-700 active:scale-[0.96]">
              Sign in
            </button>
          </SignInButton>
        </Unauthenticated>
      </div>
    </nav>
  );
}
