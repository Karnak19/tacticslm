// AI SDK DevTools, dev-only. Records every `generateText` call the process makes
// (today: `services/brain.ts`) to `.devtools/generations.json`, which
// `bun run devtools` renders.
//
// This exists because of one bug that took a whole session to find: every turn
// failed with AI_NoOutputGeneratedError, and the cause — a reasoning model
// burning the whole `maxOutputTokens` budget so the response truncated mid-JSON
// and `result.output` threw — had to be inferred from `finishReason` and token
// counts. DevTools shows the prompt, the settings and the raw bodies directly.
//
// WHY THE IMPORT IS DYNAMIC. `@ai-sdk/devtools` is a devDependency and must
// never be reachable from a production start-up path, so it is imported inside
// the function, after the NODE_ENV check, and nothing at module scope touches
// it. `DevToolsTelemetry()` itself also throws on
// NODE_ENV === "production" — this is the second lock on the same door, not a
// substitute for it.
//
// WHY RAW BODIES ARE OPT-IN. See `RECORD_RAW_BODIES` in `services/brain.ts`:
// the player's OpenRouter key transits this process and we refuse to have a
// default that writes request payloads to disk.

/** True only outside production. The single gate; `brain.ts` reads it too. */
export const DEVTOOLS_ENABLED = process.env.NODE_ENV !== "production";

/**
 * Register the DevTools telemetry integration globally, so it covers the brain
 * and any AI call added later without touching the hot path. Called from the
 * `import.meta.main` block in `app.ts`.
 *
 * Never throws: a missing or broken devtool must not stop the server booting.
 */
export async function registerDevTools(): Promise<boolean> {
  if (!DEVTOOLS_ENABLED) return false;
  try {
    const [{ registerTelemetry }, { DevToolsTelemetry }] = await Promise.all([
      import("ai"),
      import("@ai-sdk/devtools"),
    ]);
    registerTelemetry(DevToolsTelemetry());
    return true;
  } catch (e) {
    console.warn("devtools: not registered —", e instanceof Error ? e.message : String(e));
    return false;
  }
}
