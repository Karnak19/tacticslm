// An in-process, per-key async mutex.
//
// WHY THIS EXISTS
//
// `applyTurn` reads the match, checks `match.currentUnitId === unitId`, and then
// writes. In Convex that whole function was one serializable transaction: two
// concurrent calls for the same turn could not both pass the check, because the
// loser's optimistic-concurrency retry re-read the (now advanced) match and
// failed with "Not this unit's turn".
//
// SQLite gives us no such thing. `applyTurn` is an async function; the runtime
// is free to interleave two calls at any `await`, so both can read the same
// match, both see their unit as current, and both apply a turn — double-spending
// a consumable, ticking initiative twice, and inserting two turn rows for the
// same `turnNumber`. A `db.transaction` alone does NOT fix that: it makes each
// write atomic, not the read-check-write pair.
//
// So the read, the check and the write all happen inside one critical section
// keyed by `matchId`. Turns for different matches still run in parallel.
//
// THE ASSUMPTION THIS RESTS ON: there is exactly one writer process. An
// in-process mutex is worthless across processes. If the server is ever
// horizontally scaled, this has to become a database-level guard (a conditional
// UPDATE on `currentUnitId` whose row count is the lock) — not a bigger Map.

const tails = new Map<string, Promise<void>>();

/**
 * Run `fn` with exclusive access to `key`. Callers queue in arrival order, and a
 * rejecting `fn` releases the lock like any other (the rejection propagates to
 * its own caller only — it never poisons the queue).
 */
export function withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();

  // `gate` is what the *next* caller waits on; we resolve it once we are done.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mine = previous.then(() => gate);
  tails.set(key, mine);

  return previous.then(fn).finally(() => {
    release();
    // Nobody queued behind us, so drop the key rather than leak one promise per
    // match for the lifetime of the process.
    if (tails.get(key) === mine) tails.delete(key);
  });
}

/** Test-only: how many keys currently have a queue. Must return to 0 when idle. */
export function lockedKeyCount(): number {
  return tails.size;
}
