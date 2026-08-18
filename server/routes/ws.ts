// The WebSocket endpoint. One socket per room per client, three logical channels
// multiplexed over it.
//
// ── WHY IDENTITY IS RESOLVED IN `.resolve()` AND NOT IN `open` ─────────────
// VERIFIED FOOTGUN, paid for in `spike/server.ts`: Elysia delivers the first
// `message` frame BEFORE an `async open` handler has finished awaiting. So if
// you verify the token in `open` and stash the result in a map, the map is still
// empty when the first message lands — the handler throws or silently no-ops and
// the socket just goes quiet, with no error anywhere. A fast auth stub hides
// this completely, which is how it survives code review.
//
// The fix is to do the async work during the HTTP upgrade instead. `.resolve()`
// runs there, and whatever it returns lands on `ws.data`, already populated
// before `open` is called. `open` therefore stays SYNCHRONOUS. Do not add an
// `await` to it.
//
// (Elysia 1.4: `.guard(fn)` does not typecheck. The two-argument `.guard({}, fn)`
// form is required.)
//
// ── THE TOKEN IN THE QUERY STRING ─────────────────────────────────────────
// Browsers cannot set request headers on `new WebSocket(url)`, so the token has
// to ride in the URL. That is a real cost: query strings land in access logs,
// proxy logs and `Referer`-adjacent telemetry in a way `Authorization` headers
// do not. Mitigations actually applied here:
//   * the `Authorization` header is still accepted and preferred when present,
//     so non-browser clients (tests, scripts) never put a token in a URL;
//   * the token is used once, at upgrade, and never echoed back to the client
//     or included in any log line this module writes.
// The remaining exposure is the front proxy's access log. The clean fix is a
// short-lived, single-use ticket minted over authenticated HTTP and exchanged
// here — that is a small endpoint, but it is a behaviour change to the auth
// surface, so it is called out in the report rather than smuggled in.
//
// ── CHANNELS ──────────────────────────────────────────────────────────────
//   room:{id}            lobby, match start, full state, turn rows   both teams
//   room:{id}:team:{a|b} team chat                                   one team
//
// A socket is subscribed to AT MOST ONE team topic, and the team is read out of
// the caller's own `players` row. The client is never asked which team it is on
// and any team it names is ignored — see `message()`.

import { Elysia, t } from "elysia";
import { and, eq } from "drizzle-orm";
import { players } from "../../shared/schema";
import { bearerToken, currentUser } from "../auth";
import {
  type Team,
  roomTopic,
  setPublisher,
  teamTopic,
} from "../services/broadcast";
import { db } from "./context";

/** What the server knows about a socket. Derived once, at upgrade, from the DB. */
export type SocketIdentity = {
  userId: string;
  roomId: string;
  /** null for a spectator: they get the room channel and no team channel. */
  team: Team | null;
};

/**
 * The caller's team in this room, or null if they are not one of the two
 * players. Read from `players`, never from the request.
 */
function teamFor(roomId: string, userId: string): Team | null {
  const row = db()
    .select({ team: players.team })
    .from(players)
    .where(and(eq(players.roomId, roomId), eq(players.userId, userId)))
    .get();
  return row?.team ?? null;
}

export const wsRoutes = new Elysia({ name: "tacticslm/ws" })
  // Hand `broadcast` the real fan-out. `onStart` receives the composed root
  // instance, so `.server` is the live Bun server with pub/sub on it. This is
  // the ONLY place the publisher is installed, and `broadcast.ts` is the only
  // module that calls it.
  .onStart((instance) => {
    const server = instance.server;
    setPublisher(server ? (topic, payload) => void server.publish(topic, payload) : null);
  })
  .guard({}, (guarded) =>
    guarded
      .resolve(async ({ query, headers, status }) => {
        const token = bearerToken(headers.authorization) ?? query.token ?? null;
        // `currentUser`, not `requireUser`: a socket must not be able to create
        // a user row. Anyone connecting has already been through an HTTP request
        // (the hook seeds its state from one before it dials), so their row
        // exists; if it does not, 401 is the honest answer.
        const user = await currentUser(db(), token);
        if (!user) return status(401, { error: "unauthorized" });
        const identity: SocketIdentity = {
          userId: user._id,
          roomId: query.roomId,
          team: teamFor(query.roomId, user._id),
        };
        return { identity };
      })
      .ws("/ws", {
        query: t.Object({ roomId: t.String({ minLength: 1 }), token: t.Optional(t.String()) }),
        body: t.Unknown(),
        // SYNCHRONOUS on purpose. See the header comment.
        open(ws) {
          const { roomId, team, userId } = ws.data.identity;
          ws.subscribe(roomTopic(roomId));
          // At most one team topic, chosen from the stored row.
          if (team) ws.subscribe(teamTopic(roomId, team));
          ws.send(
            JSON.stringify({ type: "hello", roomId, userId, team, spectator: team === null }),
          );
        },
        message(ws, raw) {
          // The client has no authority here. It cannot subscribe, cannot name a
          // team, cannot ask for another room's traffic — everything the server
          // sends is derived from `ws.data.identity`, which was fixed at upgrade.
          // The only thing worth answering is a liveness ping.
          const type = (raw as { type?: unknown } | null)?.type;
          if (type === "ping") ws.send(JSON.stringify({ type: "pong" }));
          // Anything else, including `{ type: "subscribe", team: "b" }`, is
          // deliberately dropped without a reply.
        },
        close(ws) {
          const { roomId, team } = ws.data.identity;
          ws.unsubscribe(roomTopic(roomId));
          if (team) ws.unsubscribe(teamTopic(roomId, team));
        },
      }),
  );
