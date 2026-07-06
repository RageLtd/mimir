import { describe, expect, mock, test } from "bun:test";
import type { Surreal } from "surrealdb";
import { closeScope, type OrgScope } from "./scope";

// closeScope is the slice-5 lifecycle guard: the shared root connection must
// never be closed (every other request reuses it), while a per-request scoped
// session must be. A hand-built db exposes a close spy; the logger is mocked
// globally via the bunfig preload, so the swallow-and-log path is inert.

const mkScope = (isRoot: boolean, close: () => Promise<void>): OrgScope => ({
  orgId: isRoot ? "owner" : "org-a",
  db: { close } as unknown as Surreal,
  isRoot,
});

describe("closeScope", () => {
  test("no-ops on a root scope — never closes the shared connection", async () => {
    const close = mock(() => Promise.resolve());
    await closeScope(mkScope(true, close));
    expect(close).not.toHaveBeenCalled();
  });

  test("closes a per-request scoped connection exactly once", async () => {
    const close = mock(() => Promise.resolve());
    await closeScope(mkScope(false, close));
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("swallows a close failure — benign on an already-finished request", async () => {
    const close = mock(() => Promise.reject(new Error("already closed")));
    // Must resolve, not throw: a close error can't be allowed to escape into
    // a stream finalizer or route finally.
    await expect(closeScope(mkScope(false, close))).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
