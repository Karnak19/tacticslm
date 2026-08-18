// Temporary shim for the Elysia migration: the real module now lives in
// shared/engine.ts so both the Bun server and the browser can import it.
// Delete this file in the stage that repoints every importer at shared/ (stage 4,
// the Convex teardown) — nothing should import convex/lib/engine after that.
export * from "../../shared/engine";
