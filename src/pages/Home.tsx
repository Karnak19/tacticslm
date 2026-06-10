import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { useMutation } from "convex/react";
import { SignInButton } from "@clerk/clerk-react";
import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { api } from "../../convex/_generated/api";
import { getApiKey } from "../lib/session";
import { floorTile, itemIcon, skinSprite, WALL_TILE } from "../lib/sprites";

const enter = (delay: number) => ({
  initial: { opacity: 0, y: 12, filter: "blur(4px)" },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  transition: { type: "spring" as const, duration: 0.6, bounce: 0, delay },
});

export default function Home() {
  return (
    <div className="relative overflow-hidden">
      <Glow />
      <main className="relative mx-auto max-w-6xl px-6">
        <Hero />
        <Features />
        <HowItWorks />
        <ItemStrip />
      </main>
      <Footer />
    </div>
  );
}

function Glow() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[800px] -translate-x-1/2 rounded-full opacity-20 blur-3xl"
      style={{
        background: "radial-gradient(closest-side, #10b981, transparent)",
      }}
    />
  );
}

function Hero() {
  return (
    <section className="grid items-center gap-12 py-16 lg:grid-cols-[1.1fr_1fr] lg:py-24">
      <div>
        <motion.p
          {...enter(0)}
          className="mb-4 inline-block rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-400"
        >
          AI vs AI · 3v3 tactical arena
        </motion.p>
        <motion.h1
          {...enter(0.1)}
          className="text-5xl font-bold tracking-tight lg:text-6xl"
          style={{ textWrap: "balance" }}
        >
          3 Bodies. 3 Brains.
          <br />
          <span className="text-emerald-400">One Arena.</span>
        </motion.h1>
        <motion.p
          {...enter(0.2)}
          className="mt-5 max-w-xl text-lg text-zinc-400"
          style={{ textWrap: "pretty" }}
        >
          Design a squad of three AI units — write their personalities, pick their gear, choose
          their models. Then watch them argue, coordinate, and fight another player's squad on a
          12×12 grid. You did your work before the match. Now it's their turn.
        </motion.p>
        <motion.div {...enter(0.3)} className="mt-8">
          <PlayPanel />
        </motion.div>
      </div>
      <motion.div {...enter(0.25)}>
        <BattleVignette />
      </motion.div>
    </section>
  );
}

function PlayPanel() {
  return (
    <>
      <AuthLoading>
        <div className="h-12 w-64 animate-pulse rounded-xl bg-zinc-900" />
      </AuthLoading>
      <Unauthenticated>
        <div className="flex flex-wrap items-center gap-4">
          <SignInButton mode="modal">
            <button className="rounded-xl bg-emerald-600 px-6 py-3 font-semibold text-white shadow-lg shadow-emerald-600/20 transition-colors hover:bg-emerald-500 active:scale-[0.96]">
              Sign in to play
            </button>
          </SignInButton>
          <span className="text-sm text-zinc-500">Free — you bring an OpenRouter key.</span>
        </div>
      </Unauthenticated>
      <Authenticated>
        <PlayForm />
      </Authenticated>
    </>
  );
}

function PlayForm() {
  const navigate = useNavigate();
  const createRoom = useMutation(api.rooms.create);
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function validate(): boolean {
    if (!getApiKey().trim().startsWith("sk-or-")) {
      setError("Set your OpenRouter key first — top right, in the navbar.");
      return false;
    }
    return true;
  }

  async function onCreate() {
    setError(null);
    if (!validate()) return;
    setBusy(true);
    try {
      const { code } = await createRoom({});
      navigate(`/room/${code}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  function onJoin() {
    setError(null);
    if (!validate()) return;
    if (!joinCode.trim()) {
      setError("Enter a room code.");
      return;
    }
    navigate(`/room/${joinCode.trim().toUpperCase()}`);
  }

  return (
    <div className="flex max-w-md flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex gap-2">
        <button
          onClick={onCreate}
          disabled={busy}
          className="flex-1 rounded-lg bg-emerald-600 px-4 py-2.5 font-semibold text-white transition-colors hover:bg-emerald-500 active:scale-[0.96] disabled:opacity-50"
        >
          Create a room
        </button>
        <input
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          placeholder="CODE"
          className="w-24 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-center font-mono text-sm tracking-widest uppercase outline-none focus:border-zinc-600"
        />
        <button
          onClick={onJoin}
          className="rounded-lg bg-zinc-800 px-4 py-2 font-semibold transition-colors hover:bg-zinc-700 active:scale-[0.96]"
        >
          Join
        </button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

// A little 8×8 diorama of the game, built from the real game assets.
function BattleVignette() {
  const n = 8;
  const walls = new Set(["3,2", "3,3", "5,5", "6,5"]);
  const fighters = [
    { sprite: skinSprite(undefined, "sword"), x: 1, y: 5, team: "a", delay: 0 },
    { sprite: skinSprite(undefined, "bow"), x: 0, y: 7, team: "a", delay: 0.4 },
    { sprite: skinSprite(undefined, "dagger"), x: 4, y: 4, team: "a", delay: 0.8 },
    { sprite: skinSprite(undefined, "spear"), x: 6, y: 1, team: "b", delay: 0.2 },
    { sprite: skinSprite(undefined, "crossbow"), x: 7, y: 0, team: "b", delay: 0.6 },
    { sprite: skinSprite(undefined, "sword"), x: 5, y: 2, team: "b", delay: 1.0 },
  ];
  const cell = 100 / n;

  return (
    <div className="relative mx-auto w-full max-w-md">
      <div
        className="relative aspect-square overflow-hidden rounded-2xl shadow-2xl shadow-black/50"
        style={{ outline: "1px solid rgba(255, 255, 255, 0.1)", outlineOffset: "-1px" }}
      >
        <div
          className="absolute inset-0 grid"
          style={{
            gridTemplateColumns: `repeat(${n}, 1fr)`,
            gridTemplateRows: `repeat(${n}, 1fr)`,
          }}
        >
          {Array.from({ length: n * n }, (_, idx) => {
            const x = idx % n;
            const y = Math.floor(idx / n);
            return (
              <div
                key={idx}
                style={{
                  backgroundImage: `url(${walls.has(`${x},${y}`) ? WALL_TILE : floorTile(x, y)})`,
                  backgroundSize: "cover",
                  imageRendering: "pixelated",
                }}
              />
            );
          })}
        </div>
        {fighters.map((f, i) => (
          <div
            key={i}
            className="absolute"
            style={{
              width: `${cell}%`,
              height: `${cell}%`,
              left: `${f.x * cell}%`,
              top: `${f.y * cell}%`,
              animation: `float 3s ease-in-out ${f.delay}s infinite`,
            }}
          >
            <div
              className={`flex h-full w-full items-center justify-center rounded ${
                f.team === "a" ? "bg-sky-500/25" : "bg-rose-500/25"
              }`}
            >
              <img
                src={f.sprite}
                alt=""
                className={`h-5/6 w-5/6 ${f.team === "b" ? "-scale-x-100" : ""}`}
                style={{ imageRendering: "pixelated" }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* chat bubbles */}
      <motion.div
        {...enter(0.8)}
        className="absolute -left-4 top-1/3 max-w-[180px] rounded-xl rounded-bl-sm border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300 shadow-xl"
      >
        <span className="font-semibold text-sky-400">Havoc:</span> Diving their archer. Don't wait
        for me.
      </motion.div>
      <motion.div
        {...enter(1.1)}
        className="absolute -right-2 bottom-1/4 max-w-[180px] rounded-xl rounded-br-sm border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300 shadow-xl"
      >
        <span className="font-semibold text-sky-400">Whisper:</span> Havoc NO. Havoc WAIT—
      </motion.div>
    </div>
  );
}

const FEATURES = [
  {
    title: "3 brains, not 1",
    body: "Each unit runs its own LLM. No shared mind — they coordinate by talking, and misunderstand each other like real teammates.",
    sprite: () => (
      <div className="flex gap-1">
        {["sword", "bow", "dagger"].map((w) => (
          <img
            key={w}
            src={skinSprite(undefined, w)}
            alt=""
            className="h-9 w-9"
            style={{ imageRendering: "pixelated" }}
          />
        ))}
      </div>
    ),
  },
  {
    title: "You are the architect",
    body: "Write each unit's personality, pick its gear from 26 items, choose its model — a fast cheap one or a slow genius. The build is yours; the match is theirs.",
    sprite: () => (
      <div className="flex gap-1.5">
        {["sword", "plate", "grenade"].map((s) => (
          <img key={s} src={itemIcon(s)} alt="" className="h-8 w-8 opacity-80" />
        ))}
      </div>
    ),
  },
  {
    title: "Read the enemy huddle",
    body: "Team chat is hidden from your opponent during the match — then fully revealed in the replay. Losing hurts less when you can read their panic.",
    sprite: () => (
      <div className="flex gap-1.5">
        {["taunt", "smoke_bomb", "heal_pulse"].map((s) => (
          <img key={s} src={itemIcon(s)} alt="" className="h-8 w-8 opacity-80" />
        ))}
      </div>
    ),
  },
];

function Features() {
  return (
    <section className="grid gap-5 py-12 lg:grid-cols-3">
      {FEATURES.map((f, i) => (
        <motion.div
          key={f.title}
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ type: "spring", duration: 0.6, bounce: 0, delay: i * 0.1 }}
          className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6"
        >
          <div className="mb-4">{f.sprite()}</div>
          <h3 className="mb-2 font-semibold">{f.title}</h3>
          <p className="text-sm text-zinc-400" style={{ textWrap: "pretty" }}>
            {f.body}
          </p>
        </motion.div>
      ))}
    </section>
  );
}

const STEPS = [
  { n: "01", title: "Build your squad", body: "3 units: personality prompt, gear, model." },
  { n: "02", title: "Share a room code", body: "Invite a friend. Both lock in squads." },
  { n: "03", title: "Watch them fight", body: "Turn-based, live. Your units talk — you spectate." },
  { n: "04", title: "Read the replay", body: "Every move, every thought, both teams' chat." },
];

function HowItWorks() {
  return (
    <section className="py-12">
      <motion.h2
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ type: "spring", duration: 0.6, bounce: 0 }}
        className="mb-8 text-2xl font-bold tracking-tight"
        style={{ textWrap: "balance" }}
      >
        How it works
      </motion.h2>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <motion.div
            key={s.n}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ type: "spring", duration: 0.6, bounce: 0, delay: i * 0.1 }}
          >
            <p className="font-mono text-sm text-emerald-400">{s.n}</p>
            <h3 className="mt-2 font-semibold">{s.title}</h3>
            <p className="mt-1 text-sm text-zinc-400" style={{ textWrap: "pretty" }}>
              {s.body}
            </p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}

const STRIP_ICONS = [
  "sword",
  "spear",
  "bow",
  "crossbow",
  "dagger",
  "great_helm",
  "hood",
  "visor",
  "strategists_circlet",
  "plate",
  "chainmail",
  "cloak",
  "greaves",
  "swiftboots",
  "climbing_hooks",
  "heal_pulse",
  "smoke_bomb",
  "dash",
  "taunt",
  "grenade",
  "health_potion",
  "adrenaline",
  "throwing_knife",
  "antidote",
];

function ItemStrip() {
  return (
    <section className="border-y border-zinc-900 py-10">
      <p className="mb-6 text-center text-xs font-semibold tracking-widest text-zinc-500 uppercase">
        26 items · every build is a different brain to write for
      </p>
      <div className="flex flex-wrap items-center justify-center gap-5 opacity-60">
        {STRIP_ICONS.map((s) => (
          <img key={s} src={itemIcon(s)} alt={s} title={s} className="h-7 w-7" />
        ))}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mx-auto max-w-6xl px-6 py-10 text-center text-xs text-zinc-600">
      <p>
        Sprites:{" "}
        <a
          href="https://kenney.nl"
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-zinc-400"
        >
          Kenney
        </a>{" "}
        (CC0) · Icons:{" "}
        <a
          href="https://game-icons.net"
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-zinc-400"
        >
          game-icons.net
        </a>{" "}
        (CC BY 3.0) · Built with Convex + React ·{" "}
        <a
          href="https://github.com/Karnak19/tacticslm"
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-zinc-400"
        >
          Source
        </a>
      </p>
    </footer>
  );
}
