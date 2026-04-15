import { describe, expect, test } from "bun:test";
import { createHookRegistry } from "./registry";
import type { HookContext } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<HookContext>): HookContext {
  return {
    toolName: "bash",
    args: { command: "echo hello" },
    toolType: "server",
    project: "/test/project",
    fingerprint: "test-fp",
    availableTools: ["bash", "read", "edit", "write"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PreToolUse
// ---------------------------------------------------------------------------

describe("HookRegistry — PreToolUse", () => {
  test("returns allow when no hooks registered", async () => {
    const registry = createHookRegistry();
    const result = await registry.runPreHooks(makeCtx());
    expect(result.action).toBe("allow");
  });

  test("returns allow when all hooks allow", async () => {
    const registry = createHookRegistry();
    registry.onPreToolUse(() => ({ action: "allow" }));
    registry.onPreToolUse(() => ({ action: "allow" }));
    const result = await registry.runPreHooks(makeCtx());
    expect(result.action).toBe("allow");
  });

  test("first deny short-circuits remaining hooks", async () => {
    const registry = createHookRegistry();
    const calls: string[] = [];

    registry.onPreToolUse(() => {
      calls.push("first");
      return { action: "allow" };
    });
    registry.onPreToolUse(() => {
      calls.push("second");
      return { action: "deny", reason: "blocked" };
    });
    registry.onPreToolUse(() => {
      calls.push("third");
      return { action: "allow" };
    });

    const result = await registry.runPreHooks(makeCtx());
    expect(result.action).toBe("deny");
    expect((result as { reason: string }).reason).toBe("blocked");
    expect(calls).toEqual(["first", "second"]); // third was skipped
  });

  test("modify results are cumulative", async () => {
    const registry = createHookRegistry();

    registry.onPreToolUse((ctx) => ({
      action: "modify",
      args: { ...ctx.args, added1: true },
    }));
    registry.onPreToolUse((ctx) => ({
      action: "modify",
      args: { ...ctx.args, added2: true },
    }));

    const result = await registry.runPreHooks(
      makeCtx({ args: { original: true } }),
    );

    expect(result.action).toBe("modify");
    const args = (result as { args: Record<string, unknown> }).args;
    expect(args.original).toBe(true);
    expect(args.added1).toBe(true);
    expect(args.added2).toBe(true);
  });

  test("filter by tool name", async () => {
    const registry = createHookRegistry();
    const calls: string[] = [];

    registry.onPreToolUse(
      () => {
        calls.push("bash-only");
        return { action: "allow" };
      },
      { names: ["bash"] },
    );
    registry.onPreToolUse(
      () => {
        calls.push("read-only");
        return { action: "allow" };
      },
      { names: ["read"] },
    );

    await registry.runPreHooks(makeCtx({ toolName: "bash" }));
    expect(calls).toEqual(["bash-only"]);
  });

  test("filter by tool type", async () => {
    const registry = createHookRegistry();
    const calls: string[] = [];

    registry.onPreToolUse(
      () => {
        calls.push("server");
        return { action: "allow" };
      },
      { type: "server" },
    );
    registry.onPreToolUse(
      () => {
        calls.push("client");
        return { action: "allow" };
      },
      { type: "client" },
    );

    await registry.runPreHooks(makeCtx({ toolType: "server" }));
    expect(calls).toEqual(["server"]);
  });

  test("filter by regex pattern", async () => {
    const registry = createHookRegistry();
    const calls: string[] = [];

    registry.onPreToolUse(
      () => {
        calls.push("matched");
        return { action: "allow" };
      },
      { pattern: /^(bash|shell)$/ },
    );

    await registry.runPreHooks(makeCtx({ toolName: "bash" }));
    expect(calls).toEqual(["matched"]);

    calls.length = 0;
    await registry.runPreHooks(makeCtx({ toolName: "read" }));
    expect(calls).toEqual([]);
  });

  test("hook throwing is caught and treated as allow", async () => {
    const registry = createHookRegistry();

    registry.onPreToolUse(() => {
      throw new Error("oops");
    });
    registry.onPreToolUse(() => ({ action: "deny", reason: "after-error" }));

    const result = await registry.runPreHooks(makeCtx());
    // Error is caught, execution continues, second hook denies
    expect(result.action).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// PostToolUse
// ---------------------------------------------------------------------------

describe("HookRegistry — PostToolUse", () => {
  test("returns original result when no hooks registered", async () => {
    const registry = createHookRegistry();
    const result = await registry.runPostHooks({
      ...makeCtx(),
      result: { data: "original" },
      durationMs: 100,
    });
    expect(result).toEqual({ data: "original" });
  });

  test("hook can modify result", async () => {
    const registry = createHookRegistry();

    registry.onPostToolUse((ctx) => ({
      result: { ...(ctx.result as object), modified: true },
    }));

    const result = await registry.runPostHooks({
      ...makeCtx(),
      result: { data: "original" },
      durationMs: 100,
    });
    expect(result).toEqual({ data: "original", modified: true });
  });

  test("void return leaves result unchanged", async () => {
    const registry = createHookRegistry();
    const observed: unknown[] = [];

    registry.onPostToolUse((ctx) => {
      observed.push(ctx.result);
      // void return — no modification
    });

    const result = await registry.runPostHooks({
      ...makeCtx(),
      result: { data: "original" },
      durationMs: 100,
    });
    expect(result).toEqual({ data: "original" });
    expect(observed).toEqual([{ data: "original" }]);
  });

  test("multiple hooks see cumulative modifications", async () => {
    const registry = createHookRegistry();

    registry.onPostToolUse((ctx) => ({
      result: { ...(ctx.result as object), step1: true },
    }));
    registry.onPostToolUse((ctx) => ({
      result: { ...(ctx.result as object), step2: true },
    }));

    const result = await registry.runPostHooks({
      ...makeCtx(),
      result: { original: true },
      durationMs: 50,
    });
    expect(result).toEqual({ original: true, step1: true, step2: true });
  });

  test("hook throwing is caught, original result preserved", async () => {
    const registry = createHookRegistry();

    registry.onPostToolUse(() => {
      throw new Error("post-hook error");
    });

    const result = await registry.runPostHooks({
      ...makeCtx(),
      result: { data: "safe" },
      durationMs: 10,
    });
    expect(result).toEqual({ data: "safe" });
  });
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

describe("HookRegistry — stats", () => {
  test("reports correct hook counts", () => {
    const registry = createHookRegistry();
    expect(registry.stats).toEqual({ pre: 0, post: 0, lifecycle: 0 });

    registry.onPreToolUse(() => ({ action: "allow" }));
    registry.onPreToolUse(() => ({ action: "allow" }));
    registry.onPostToolUse(() => {});
    registry.onLifecycle(() => {});

    expect(registry.stats).toEqual({ pre: 2, post: 1, lifecycle: 1 });
  });
});
