import { expect, test } from "bun:test";
import { withTimeout } from "./timeout";

test("resolves with the promise value when it beats the deadline", async () => {
  const result = await withTimeout(Promise.resolve(42), 1000, "fast op");
  expect(result).toBe(42);
});

test("propagates the promise's own rejection unchanged", async () => {
  const boom = new Error("upstream failure");
  expect(withTimeout(Promise.reject(boom), 1000, "failing op")).rejects.toBe(
    boom,
  );
});

test("rejects with a labelled error when the deadline wins", async () => {
  const never = new Promise<void>(() => {});
  expect(withTimeout(never, 10, "SurrealDB connect")).rejects.toThrow(
    "SurrealDB connect timed out after 10ms",
  );
});

test("does not reject late when the promise wins the race", async () => {
  // If the timer were left armed, the rejection would surface as an
  // unhandled rejection after the test — Bun fails the run on those.
  const result = await withTimeout(Promise.resolve("ok"), 5, "quick op");
  expect(result).toBe("ok");
  await new Promise((r) => setTimeout(r, 15));
});
