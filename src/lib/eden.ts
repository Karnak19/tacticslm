// The typed API client. `treaty<App>` reads the route table straight off the
// server's own type, so a renamed route or a changed body shape is a compile
// error here rather than a 404 at runtime.
//
// Base URL is the current origin, and that is not a shortcut: in prod Elysia
// serves the bundle and the API together, and in dev Vite proxies `/api` to
// Elysia (see `vite.config.ts`). Same origin both ways, so there is no base URL
// to configure and no CORS to arrange.
//
// Auth is an `Authorization: Bearer` header from Clerk. Worth saying explicitly
// because the WebSocket in a later stage cannot do this — browsers refuse to let
// you set headers on `new WebSocket`, so that path has to put the token in the
// query string. This is plain HTTP, so the header is available and is right.

import { treaty } from "@elysiajs/eden";
import type { App } from "../../server/app";

/** Set once by `<ClerkTokenBridge>`; see `useEdenAuth` below. */
let getToken: (() => Promise<string | null>) | null = null;

/**
 * Hand the client Clerk's token getter. Call this from a component inside
 * `<ClerkProvider>`: `useEffect(() => setTokenGetter(getToken), [getToken])`
 * where `getToken` comes from `useAuth()`.
 */
export function setTokenGetter(getter: (() => Promise<string | null>) | null): void {
  getToken = getter;
}

export const api = treaty<App>(
  typeof window === "undefined" ? "localhost:4321" : window.location.host,
  {
    async onRequest() {
      const token = await getToken?.();
      // Returning no headers at all leaves the request anonymous, which is
      // correct for the read paths that degrade to an empty result.
      return token ? { headers: { authorization: `Bearer ${token}` } } : {};
    },
  },
);

/**
 * Eden returns `{ data, error }` rather than throwing. Most call sites want the
 * Convex behaviour — a thrown `Error` carrying the server's message, which the
 * lobby already knows how to display — so unwrap here in one place.
 */
export function unwrap<T>(result: { data: T | null; error: unknown }): T {
  if (result.error) {
    const value = (result.error as { value?: unknown }).value;
    const message =
      typeof value === "object" && value !== null && "error" in value
        ? String((value as { error: unknown }).error)
        : String(value ?? "Request failed");
    throw new Error(message);
  }
  return result.data as T;
}
