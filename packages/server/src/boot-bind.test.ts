import { describe, expect, test } from "bun:test";

import { attemptSync } from "./util/result";

/**
 * MIM-80 mechanism pin: Bun.serve on an occupied port throws
 * synchronously, and attemptSync captures it as a Result. This is the
 * exact seam index.ts relies on to turn a bind failure into
 * log.fatal + exit(1) instead of a suppressed unhandledRejection —
 * if Bun ever changes bind failure to an async rejection, this test
 * breaks before the zombie comes back.
 */
describe("Bun.serve bind failure", () => {
  test("second bind on an occupied port is a synchronous, capturable error", () => {
    const first = Bun.serve({
      port: 0, // OS-assigned free port
      fetch: () => new Response("occupied"),
    });

    const [err, second] = attemptSync(() =>
      Bun.serve({
        port: first.port,
        fetch: () => new Response("zombie"),
      }),
    );

    first.stop(true);
    // Defensive: if the bind unexpectedly succeeded, don't leak it.
    if (second) second.stop(true);

    expect(second).toBeNull();
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/port|address|use/i);
  });
});
