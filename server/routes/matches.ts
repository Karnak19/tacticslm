// Match HTTP surface over `server/services/matches.ts`.
//
// NOTE, deliberately: there is no route here that advances a turn. In Convex the
// turn mutation was an `internalMutation`, unreachable from any client, and that
// unreachability is the whole anti-cheat story — the LLM brain is the only thing
// that may move a unit. The boundary test in `server/services/` scans this
// directory for the turn mutation's name and fails if it ever appears here.
//
// SECRECY BOUNDARY: `/team-messages` takes NO team parameter. The service reads
// the caller's team off their own `players` row. Adding a `?team=` here would
// hand each player the enemy's plans, which is the one thing the design is
// built to prevent.

import { Elysia, t } from "elysia";
import * as matchesService from "../services/matches";
import { context } from "./context";

export const matchRoutes = new Elysia({ prefix: "/matches" })
  .use(context)
  // GET /api/matches/by-room/:roomId -> { match, units } | null
  .get(
    "/by-room/:roomId",
    async ({ db, user, params }) => {
      await user();
      return matchesService.byRoom(db, params.roomId);
    },
    { params: t.Object({ roomId: t.String() }) },
  )
  // GET /api/matches/:id/replay -> turns always, messages only once finished.
  .get(
    "/:id/replay",
    async ({ db, user, params, status }) => {
      await user();
      const result = matchesService.replay(db, params.id);
      if (!result) return status(404, { error: "Match not found" });
      return result;
    },
    { params: t.Object({ id: t.String() }) },
  )
  // GET /api/matches/:id/team-messages -> the caller's own team's chat, only.
  .get(
    "/:id/team-messages",
    async ({ db, maybeUser, params }) => matchesService.teamMessages(db, await maybeUser(), params.id),
    { params: t.Object({ id: t.String() }) },
  )
  // POST /api/matches/:id/forfeit
  .post(
    "/:id/forfeit",
    async ({ db, user, params }) => {
      await matchesService.forfeit(db, await user(), params.id);
      return { ok: true as const };
    },
    { params: t.Object({ id: t.String() }) },
  );
