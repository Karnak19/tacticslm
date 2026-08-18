// Lobby HTTP surface. Thin wrappers over `server/services/rooms.ts` — the
// service owns every transaction and every rule; a handler here only
// authenticates, validates the body shape, and calls through.

import { Elysia, t } from "elysia";
import * as roomsService from "../services/rooms";
import { context } from "./context";

export const roomRoutes = new Elysia({ prefix: "/rooms" })
  .use(context)
  // POST /api/rooms -> { roomId, code }
  .post("/", async ({ db, user }) => roomsService.create(db, await user()))
  // POST /api/rooms/join/:code -> { roomId }
  //
  // DEVIATION from the plan, forced by the router: `/rooms/:code/join` and
  // `/rooms/:id/squad` put two DIFFERENTLY-NAMED parameters in the same slot,
  // and memoirist refuses to build that tree ("a route already exists with a
  // different parameter name"). Putting the static `join` segment first sidesteps
  // it without renaming the parameter to something that lies about its contents.
  .post(
    "/join/:code",
    async ({ db, user, params }) => ({ roomId: roomsService.join(db, await user(), params.code) }),
    { params: t.Object({ code: t.String({ minLength: 1, maxLength: 12 }) }) },
  )
  // GET /api/rooms/:id -> lobby state, plus the latest match id for redirects.
  .get(
    "/:id",
    async ({ db, user, params, status }) => {
      await user();
      const state = roomsService.get(db, params.id);
      if (!state) return status(404, { error: "Room not found" });
      return { ...state, matchId: roomsService.latestMatchId(db, params.id) };
    },
    { params: t.Object({ id: t.String() }) },
  )
  // POST /api/rooms/:id/squad
  .post(
    "/:id/squad",
    async ({ db, user, params, body }) => {
      roomsService.setSquad(db, await user(), params.id, body.rosterUnitIds);
      return { ok: true as const };
    },
    {
      params: t.Object({ id: t.String() }),
      // Exactly 3 is re-checked (as DISTINCT) by the service; the schema keeps a
      // malformed payload from ever reaching it.
      body: t.Object({ rosterUnitIds: t.Array(t.String(), { minItems: 3, maxItems: 3 }) }),
    },
  )
  // POST /api/rooms/:id/ready -> { matchId } once both players are ready.
  .post(
    "/:id/ready",
    async ({ db, user, params, body }) => {
      const matchId = roomsService.setReady(db, await user(), params.id, body.ready);
      // The broadcast hook lives in the service, but it must fire after commit,
      // and `setReady` already returns post-commit. Stage 5 owns the socket.
      if (matchId) roomsService.notifyMatchStarted(params.id, matchId);
      return { matchId };
    },
    { params: t.Object({ id: t.String() }), body: t.Object({ ready: t.Boolean() }) },
  )
  // GET /api/rooms/by-code/:code -> the room a lobby code points at.
  .get(
    "/by-code/:code",
    async ({ db, user, params, status }) => {
      await user();
      const room = roomsService.byCode(db, params.code);
      if (!room) return status(404, { error: "Room not found" });
      return room;
    },
    { params: t.Object({ code: t.String({ minLength: 1, maxLength: 12 }) }) },
  );
