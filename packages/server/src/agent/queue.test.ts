/**
 * Tests for the LLM-call serialization queue.
 */

import { describe, expect, test } from "bun:test";
import { currentQueueDepth, enqueueLlmCall } from "./queue";

describe("enqueueLlmCall", () => {
  test("runs a single call and returns its result", async () => {
    const result = await enqueueLlmCall(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  test("propagates errors to the caller without breaking the chain", async () => {
    const err = await enqueueLlmCall(() =>
      Promise.reject(new Error("boom")),
    )
      .then(() => null)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("boom");

    // Chain still works after a rejection.
    const next = await enqueueLlmCall(() => Promise.resolve("ok"));
    expect(next).toBe("ok");
  });

  test("serializes concurrent calls — second does not start until first resolves", async () => {
    const events: string[] = [];

    const makeCall = (label: string, delayMs: number) => {
      return () =>
        new Promise<void>((resolve) => {
          events.push(`${label}:start`);
          setTimeout(() => {
            events.push(`${label}:end`);
            resolve();
          }, delayMs);
        });
    };

    const a = enqueueLlmCall(makeCall("A", 20));
    const b = enqueueLlmCall(makeCall("B", 5));
    const c = enqueueLlmCall(makeCall("C", 1));

    await Promise.all([a, b, c]);

    // Strict ordering: A runs fully, then B runs fully, then C.
    expect(events).toEqual([
      "A:start",
      "A:end",
      "B:start",
      "B:end",
      "C:start",
      "C:end",
    ]);
  });

  test("currentQueueDepth reflects queued work", async () => {
    const initial = currentQueueDepth();

    // Pre-build the pending-promise so the resolver is captured
    // synchronously at enqueue time (fn runs on a later microtask).
    let resolveA: () => void = () => {};
    const pendingA = new Promise<void>((r) => {
      resolveA = r;
    });
    const a = enqueueLlmCall(() => pendingA);
    const b = enqueueLlmCall(() => Promise.resolve());

    // Both queued; depth should be at least initial + 2
    expect(currentQueueDepth()).toBeGreaterThanOrEqual(initial + 2);

    resolveA();
    await Promise.all([a, b]);
    // Let the chain's decrement microtasks drain.
    await Promise.resolve();
    await Promise.resolve();

    // Settled back to ~initial
    expect(currentQueueDepth()).toBe(initial);
  });
});
