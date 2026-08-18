// Runs both dev processes under one command.
//
// Dev needs two: Vite serves the SPA with HMR and proxies /api and /ws across to
// Elysia (see the `server.proxy` stanza in vite.config.ts). Production needs only
// one, because Elysia serves the built dist/ itself.
//
// This is a stopgap. Bun 1.3's fullstack dev server can host the SPA from inside
// Elysia — one process, no proxy, same-origin sockets — and a spike proved it
// works, Tailwind and websockets included. It is parked until the app is signed
// off end to end on Vite, because the one unverified piece is code splitting:
// the current build emits hundreds of lazy shiki/streamdown chunks and Bun's
// emitted a single 1.4 MB file. See spike-fullstack/server.ts.
const procs = [
  Bun.spawn(["bun", "--watch", "server/app.ts"], { stdio: ["inherit", "inherit", "inherit"] }),
  Bun.spawn(["bunx", "vite"], { stdio: ["inherit", "inherit", "inherit"] }),
];

// One dying should take the other with it, or you are left with half a stack
// listening and no obvious sign of it.
const stop = () => {
  for (const p of procs) p.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await Promise.race(procs.map((p) => p.exited));
stop();
