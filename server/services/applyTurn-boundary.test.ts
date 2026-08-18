// A mechanical stand-in for Convex's `internalMutation`.
//
// In Convex, `matches.applyTurn` was an `internalMutation`: the runtime made it
// unreachable from any client, which is what guaranteed players could not
// hand-craft actions — the LLM really was the one playing. Plain TypeScript has
// no such thing. `server/services/brain.ts` is the only legitimate caller, and
// the only enforcement left is that nobody imports it anywhere else.
//
// So the enforcement is this test. If `applyTurn` ever shows up under
// `server/routes/`, the suite goes red and the reviewer gets the reason with it.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROUTES_DIR = "server/routes";
const SERVICES_DIR = "server/services";

function walk(dir: string): Array<string> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe("applyTurn stays out of the route layer", () => {
  test("no file under server/routes/ mentions applyTurn", () => {
    const offenders = walk(ROUTES_DIR).filter((path) =>
      readFileSync(path, "utf8").includes("applyTurn"),
    );
    expect(offenders).toEqual([]);
  });

  test("brain.ts is the only service that calls applyTurn", () => {
    const callers = walk(SERVICES_DIR)
      .filter((path) => !path.endsWith(".test.ts") && !path.endsWith("/testing.ts"))
      .filter((path) => path !== join(SERVICES_DIR, "matches.ts"))
      // A call or an import, not a prose mention: `lock.ts` legitimately explains
      // itself by naming `applyTurn` in a comment.
      .filter((path) =>
        /applyTurn\s*\(|import\s*\{[^}]*\bapplyTurn\b/.test(readFileSync(path, "utf8")),
      );
    expect(callers).toEqual([join(SERVICES_DIR, "brain.ts")]);
  });
});
