// The one route that makes a unit act. Port of Convex's `brain.act` action.
//
// ── WHY THIS RETURNS 202 AND NOT THE RESULT ────────────────────────────────
// On Convex the client called the action and awaited it. That worked because
// Convex capped actions at 10 minutes and nothing sat between the browser and
// the function, so a turn could take its full 45-second retry budget with no
// client-side timeout — and the code deliberately has none, because aborting
// mid-response was causing spurious failures.
//
// Here there is a proxy in front of the server with its own idle timeout. We
// could raise it above 45s; instead the route hands the turn off and answers
// immediately, because the awaited version was only ever a workaround:
//
//   * The turn's result does not need this response. The turn mutation in
//     `services/matches.ts` already publishes `match:turn` / `match:state` / `match:finished` to the
//     room over the socket, so every client — including spectators, who never
//     made this request at all — learns the outcome the same way regardless.
//     Awaiting here would deliver the same news twice, once slowly.
//   * A 45-second hanging fetch in a browser is a liability, not a feature: it
//     is the thing that breaks when a phone sleeps, a tab is backgrounded, or
//     any hop in between decides it has waited long enough.
//   * It removes the retry budget from the request's critical path entirely,
//     so raising or lowering LLM_TIME_BUDGET_MS is no longer an infrastructure
//     question.
//
// WHAT THIS COSTS: the caller no longer learns why a turn failed. That is
// acceptable because a failed turn is not silent — `takeTurn`'s safe fallback
// applies a `wait` with the error text in `thinking`, which is broadcast and
// rendered like any other turn. The only thing that reaches nobody is a crash
// in the fallback itself, so that one is logged loudly here.
//
// Note that this file never reaches the turn mutation itself, and must not: the
// brain service is the only caller, and the boundary test in `server/services/`
// scans this directory to keep it that way.

import { Elysia, t } from "elysia";
import * as brain from "../services/brain";
import { context } from "./context";

/**
 * Matches with a turn already running in this process.
 *
 * Without it, a double-click (or a client that retries on the 202) starts a
 * second model call for the same unit. It would not corrupt anything — the
 * loser finds the turn already taken and reports `skipped` — but it bills the
 * player for a second call and burns the budget for nothing.
 *
 * Same assumption as `services/lock.ts`: one writer process. This is a courtesy,
 * not the correctness guarantee; that stays in the turn mutation under its lock.
 */
const inFlight = new Set<string>();

export const brainRoutes = new Elysia({ prefix: "/brain" })
  .use(context)
  // POST /api/brain/act -> 202 { status: "accepted" | "skipped" }
  //
  // The key travels in the body and is used for this one call: never stored,
  // never logged, never echoed back.
  .post(
    "/act",
    async ({ db, user, body, status }) => {
      const me = await user();

      // Owner-gated: `turnContext` returns null when it is not the caller's
      // unit's turn, which is the same "skipped" contract the action had. Doing
      // it here, before the 202, is what keeps that answer synchronous.
      const ctxData = brain.turnContext(db, body.matchId, me._id);
      if (!ctxData) return status(202, { status: "skipped" as const, reason: "not your turn" });
      if (inFlight.has(body.matchId)) {
        return status(202, { status: "skipped" as const, reason: "turn already in flight" });
      }

      inFlight.add(body.matchId);
      void brain
        .takeTurn(db, body.matchId, body.apiKey, ctxData)
        .catch((e: unknown) => {
          // Only reachable if the safe `wait` fallback ALSO failed, i.e. nothing
          // was broadcast and the match may now be stuck. Nobody is awaiting
          // this, so the log is the only report there is.
          console.error(
            `brain.act: turn for match ${body.matchId} failed with no fallback applied:`,
            e instanceof Error ? `${e.name}: ${e.message}` : String(e),
          );
        })
        .finally(() => inFlight.delete(body.matchId));

      return status(202, { status: "accepted" as const });
    },
    {
      body: t.Object({ matchId: t.String(), apiKey: t.String() }),
    },
  );
