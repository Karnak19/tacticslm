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

/**
 * The file with its comments blanked out.
 *
 * WHY: the scan below used to be `contents.includes("applyTurn")` on the raw
 * text, which made the guard punish the very documentation that keeps the
 * invariant alive — `server/routes/dev.ts` explains in a comment that it must
 * route through the brain service and never touch `applyTurn`, and that comment
 * alone turned the suite red. A prose mention is not a call, so comments are
 * stripped before anything is matched. String literals are left alone: nothing
 * legitimately names the mutation in a string, and blanking them would hide a
 * dynamic `services.matches["applyTurn"]` dodge.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string): Array<string> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe("applyTurn stays out of the route layer", () => {
  test("no file under server/routes/ calls applyTurn (comments excluded)", () => {
    const offenders = walk(ROUTES_DIR).filter((path) => code(path).includes("applyTurn"));
    expect(offenders).toEqual([]);
  });

  test("brain.ts is the only service that calls applyTurn", () => {
    const callers = walk(SERVICES_DIR)
      .filter((path) => !path.endsWith(".test.ts") && !path.endsWith("/testing.ts"))
      .filter((path) => path !== join(SERVICES_DIR, "matches.ts"))
      // A call or an import, not a prose mention: `lock.ts` legitimately explains
      // itself by naming `applyTurn` in a comment.
      .filter((path) => /applyTurn\s*\(|import\s*\{[^}]*\bapplyTurn\b/.test(code(path)));
    expect(callers).toEqual([join(SERVICES_DIR, "brain.ts")]);
  });
});
