import { beforeEach, describe, expect, test } from "bun:test";
import type { HookContext, PostToolUseContext } from "../types";
import {
  FlailingTracker,
  getFlailingTracker,
  setFlailingTracker,
} from "../flailing-tracker";
import { registerFlailingHooks } from "./flailing";
import { HookRegistry } from "../registry";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePreContext(overrides: Partial<HookContext> = {}): HookContext {
  return {
    toolName: "read",
    args: { path: "/test/file.ts" },
    toolType: "server",
    project: "/test",
    fingerprint: "test-session",
    ...overrides,
  };
}

function makePostContext(
  result: unknown,
  overrides: Partial<PostToolUseContext> = {},
): PostToolUseContext {
  return {
    ...makePreContext(overrides),
    result,
    durationMs: 100,
  };
}

// ---------------------------------------------------------------------------
// Observer hook tests
// ---------------------------------------------------------------------------

describe("flailingObserverHook", () => {
  let registry: HookRegistry;
  let tracker: FlailingTracker;

  beforeEach(() => {
    registry = new HookRegistry();
    tracker = new FlailingTracker(20);
    setFlailingTracker(tracker);
    registerFlailingHooks(registry);
  });

  test("records tool calls into tracker", async () => {
    const ctx = makePostContext("OK");
    await registry.runPostHooks(ctx);

    const state = tracker.get("test-session");
    expect(state.window).toHaveLength(1);
    expect(state.window[0]!.toolName).toBe("read");
    expect(state.window[0]!.target).toBe("/test/file.ts");
    expect(state.window[0]!.isError).toBe(false);
  });

  test("detects errors from result content", async () => {
    const ctx = makePostContext("Error: ENOENT no such file");
    await registry.runPostHooks(ctx);

    const state = tracker.get("test-session");
    expect(state.window[0]!.isError).toBe(true);
  });

  test("extracts target from bash commands", async () => {
    const ctx = makePostContext("done", {
      toolName: "bash",
      args: { command: "cat /etc/passwd" },
    });
    await registry.runPostHooks(ctx);

    const state = tracker.get("test-session");
    expect(state.window[0]!.target).toBe("/etc/passwd");
  });

  test("never modifies the result", async () => {
    const ctx = makePostContext({ status: "success" });
    const result = await registry.runPostHooks(ctx);
    expect(result).toEqual({ status: "success" });
  });

  test("isolates sessions by fingerprint", async () => {
    await registry.runPostHooks(makePostContext("a", { fingerprint: "s1" }));
    await registry.runPostHooks(makePostContext("b", { fingerprint: "s2" }));

    expect(tracker.get("s1").window).toHaveLength(1);
    expect(tracker.get("s2").window).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Interceptor hook tests
// ---------------------------------------------------------------------------

describe("flailingInterceptorHook", () => {
  let registry: HookRegistry;
  let tracker: FlailingTracker;

  beforeEach(() => {
    registry = new HookRegistry();
    tracker = new FlailingTracker(20);
    setFlailingTracker(tracker);
    registerFlailingHooks(registry);
  });

  test("allows when score below threshold", async () => {
    // Single call, score = 0
    const result = await registry.runPreHooks(makePreContext());
    expect(result).toEqual({ action: "allow" });
  });

  test("denies with nudge when score at threshold", async () => {
    // 5 consecutive identical calls: (5-1)/(7-1) ≈ 0.67 > 0.6 threshold
    for (let i = 0; i < 5; i++) {
      tracker.record("test-session", {
        toolName: "read",
        target: "/test/file.ts",
        resultSnippet: "OK",
        isError: false,
        at: Date.now(),
      });
    }

    const result = await registry.runPreHooks(makePreContext());

    expect(result.action).toBe("deny");
    if (result.action === "deny") {
      expect(result.reason).toContain("repeating similar tool calls");
      expect(result.reason).toContain("step back");
    }

    // Nudge count should be incremented
    expect(tracker.get("test-session").nudgeCount).toBe(1);
  });

  test("stronger denial after repeated nudges", async () => {
    // Set up high score
    for (let i = 0; i < 5; i++) {
      tracker.record("test-session", {
        toolName: "read",
        target: "/test/file.ts",
        resultSnippet: "OK",
        isError: false,
        at: Date.now(),
      });
    }

    // Trigger nudges until we hit MAX_NUDGES
    for (let i = 0; i < 3; i++) {
      await registry.runPreHooks(makePreContext());
    }

    const result = await registry.runPreHooks(makePreContext());

    expect(result.action).toBe("deny");
    if (result.action === "deny") {
      expect(result.reason).toContain("STOP");
      expect(result.reason).toContain("fundamentally change");
    }

    expect(tracker.get("test-session").nudgeCount).toBe(4);
  });

  test("uses 'default' session when fingerprint is null", async () => {
    const ctx = makePreContext({ fingerprint: null });

    // Add some history
    tracker.record("default", {
      toolName: "read",
      target: "/test",
      resultSnippet: "OK",
      isError: false,
      at: Date.now(),
    });

    const result = await registry.runPreHooks(ctx);
    expect(result).toEqual({ action: "allow" });

    // Verify it's using the "default" session
    expect(tracker.get("default").window).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("flailing hooks integration", () => {
  let registry: HookRegistry;
  let tracker: FlailingTracker;

  beforeEach(() => {
    registry = new HookRegistry();
    tracker = new FlailingTracker(20);
    setFlailingTracker(tracker);
    registerFlailingHooks(registry);
  });

  test("observer populates tracker, interceptor checks score", async () => {
    // Record 5 identical calls via observer: (5-1)/(7-1) ≈ 0.67 > 0.6 threshold
    for (let i = 0; i < 5; i++) {
      await registry.runPostHooks(makePostContext("OK"));
    }

    expect(tracker.computeScore("test-session")).toBeCloseTo(0.67, 2);

    // Next pre-hook should deny
    const result = await registry.runPreHooks(makePreContext());
    expect(result.action).toBe("deny");
  });

  test("error detection increases score", async () => {
    // 4 consecutive identical errors via observer: 4/4 = 1.0
    for (let i = 0; i < 4; i++) {
      await registry.runPostHooks(makePostContext("Error: ENOENT"));
    }

    // Score should be 1.0 (4 consecutive errors = ERROR_RUN_CEILING)
    expect(tracker.computeScore("test-session")).toBe(1.0);

    // Should be denied
    const result = await registry.runPreHooks(makePreContext());
    expect(result.action).toBe("deny");
  });
});