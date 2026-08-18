import { expect, test } from "bun:test";
import { lockedKeyCount, withLock } from "./lock";

test("the same key serialises: no two bodies overlap", async () => {
  const trace: Array<string> = [];
  let inside = 0;
  const body = (tag: string) => async () => {
    inside++;
    expect(inside).toBe(1); // the whole point
    trace.push(`${tag}:in`);
    await Bun.sleep(5);
    trace.push(`${tag}:out`);
    inside--;
  };

  await Promise.all([
    withLock("m1", body("a")),
    withLock("m1", body("b")),
    withLock("m1", body("c")),
  ]);

  // Arrival order is preserved, and every body ran to completion before the next.
  expect(trace).toEqual(["a:in", "a:out", "b:in", "b:out", "c:in", "c:out"]);
});

test("different keys run in parallel", async () => {
  let concurrent = 0;
  let peak = 0;
  const body = async () => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    await Bun.sleep(5);
    concurrent--;
  };
  await Promise.all([withLock("x", body), withLock("y", body), withLock("z", body)]);
  expect(peak).toBe(3);
});

test("a throwing body releases the lock and does not poison the queue", async () => {
  const first = withLock("m2", async () => {
    await Bun.sleep(1);
    throw new Error("boom");
  });
  const second = withLock("m2", () => "ok");

  await expect(first).rejects.toThrow("boom");
  expect(await second).toBe("ok");
});

test("the key map does not leak once the queue drains", async () => {
  await Promise.all([withLock("m3", () => 1), withLock("m3", () => 2)]);
  // Give the final `finally` its microtask.
  await Bun.sleep(1);
  expect(lockedKeyCount()).toBe(0);
});
