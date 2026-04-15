import { beforeEach, describe, expect, test } from "bun:test";
import { type HookRegistry, createHookRegistry } from "../registry";
import { type TaskTracker, createTaskTracker, setTaskTracker } from "../task-tracker";
import type { HookContext, PostToolUseContext } from "../types";
import { detectTaskType, registerBackgroundHook } from "./background";

function bashCtx(
  command: string,
  overrides: Partial<HookContext> = {},
): HookContext {
  return {
    toolName: "bash",
    args: { command },
    toolType: "server",
    project: "/test",
    fingerprint: "test-fp",
    ...overrides,
  };
}

function makeRegistry(): HookRegistry {
  const registry = createHookRegistry();
  registerBackgroundHook(registry);
  return registry;
}

describe("detectTaskType", () => {
  test("detects cargo build", () => {
    expect(detectTaskType("cargo build --release")?.taskType).toBe("build");
  });

  test("detects cargo test", () => {
    expect(detectTaskType("cargo test -- --nocapture")?.taskType).toBe("build");
  });

  test("detects cargo clippy", () => {
    expect(detectTaskType("cargo clippy --all-targets")?.taskType).toBe(
      "build",
    );
  });

  test("detects npm run build", () => {
    expect(detectTaskType("npm run build")?.taskType).toBe("build");
  });

  test("detects npm test", () => {
    expect(detectTaskType("npm test")?.taskType).toBe("build");
  });

  test("detects npm install", () => {
    expect(detectTaskType("npm install")?.taskType).toBe("install");
  });

  test("detects bun build", () => {
    expect(detectTaskType("bun build ./src/index.ts")?.taskType).toBe("build");
  });

  test("detects bun test", () => {
    expect(detectTaskType("bun test")?.taskType).toBe("build");
  });

  test("detects bun install", () => {
    expect(detectTaskType("bun install")?.taskType).toBe("install");
  });

  test("detects make", () => {
    expect(detectTaskType("make -j8")?.taskType).toBe("build");
  });

  test("detects docker build", () => {
    expect(detectTaskType("docker build -t myapp .")?.taskType).toBe("build");
  });

  test("detects docker compose up", () => {
    expect(detectTaskType("docker compose up -d")?.taskType).toBe("build");
  });

  test("detects tsc", () => {
    expect(detectTaskType("tsc --noEmit")?.taskType).toBe("lint");
  });

  test("detects eslint", () => {
    expect(detectTaskType("eslint src/.")?.taskType).toBe("lint");
  });

  test("detects biome check", () => {
    expect(detectTaskType("biome check .")?.taskType).toBe("lint");
  });

  test("returns null for non-matching commands", () => {
    expect(detectTaskType("echo hello")).toBeNull();
  });

  test("returns null for ls", () => {
    expect(detectTaskType("ls -la")).toBeNull();
  });

  test("returns null for cat", () => {
    expect(detectTaskType("cat file.txt")).toBeNull();
  });

  test("returns null for git status", () => {
    expect(detectTaskType("git status")).toBeNull();
  });
});

describe("Background Task Manager — PreToolUse", () => {
  test("modifies cargo build command", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("cargo build --release"),
    );
    expect(result.action).toBe("modify");
    if (result.action !== "modify") return;
    expect(result.args.command).toMatch(
      /cargo build --release 2>&1 \| tee \/tmp\/mimir-build-\d+\.log &/,
    );
    expect(result.args._background).toBeDefined();
  });

  test("modifies npm test command", async () => {
    const result = await makeRegistry().runPreHooks(bashCtx("npm test"));
    expect(result.action).toBe("modify");
    if (result.action !== "modify") return;
    expect(result.args.command).toMatch(
      /npm test 2>&1 \| tee \/tmp\/mimir-build-\d+\.log &/,
    );
  });

  test("modifies bun install command", async () => {
    const result = await makeRegistry().runPreHooks(bashCtx("bun install"));
    expect(result.action).toBe("modify");
    if (result.action !== "modify") return;
    expect(result.args.command).toMatch(
      /bun install 2>&1 \| tee \/tmp\/mimir-install-\d+\.log &/,
    );
  });

  test("preserves _background metadata in modified args", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("cargo clippy --all-targets"),
    );
    expect(result.action).toBe("modify");
    if (result.action !== "modify") return;

    const meta = result.args._background as {
      logPath: string;
      taskType: string;
      startedAt: number;
      originalCommand: string;
    };
    expect(meta.taskType).toBe("build");
    expect(meta.logPath).toMatch(/^\/tmp\/mimir-build-\d+\.log$/);
    expect(meta.originalCommand).toBe("cargo clippy --all-targets");
    expect(meta.startedAt).toBeGreaterThan(0);
  });

  // --- Should NOT modify ---

  test("allows non-matching commands through", async () => {
    const result = await makeRegistry().runPreHooks(bashCtx("echo hello"));
    expect(result.action).toBe("allow");
  });

  test("allows git commands through", async () => {
    const result = await makeRegistry().runPreHooks(bashCtx("git status"));
    expect(result.action).toBe("allow");
  });

  test("skips already backgrounded commands (trailing &)", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("cargo build --release &"),
    );
    expect(result.action).toBe("allow");
  });

  test("skips commands using nohup", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("nohup cargo build --release"),
    );
    expect(result.action).toBe("allow");
  });

  test("skips commands with output redirection", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("cargo build --release > build.log"),
    );
    expect(result.action).toBe("allow");
  });

  test("skips commands already using tee", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("cargo build --release 2>&1 | tee build.log"),
    );
    expect(result.action).toBe("allow");
  });

  test("allows non-bash tools through", async () => {
    const result = await makeRegistry().runPreHooks({
      toolName: "read",
      args: { command: "cargo build" },
      toolType: "server",
      project: "/test",
      fingerprint: "test-fp",
    });
    // read tool doesn't match the filter pattern, so it's never checked
    expect(result.action).toBe("allow");
  });

  test("allows empty command", async () => {
    const result = await makeRegistry().runPreHooks(bashCtx(""));
    expect(result.action).toBe("allow");
  });
});

describe("Background Task Manager — PostToolUse", () => {
  let tracker: TaskTracker;
  let registry: HookRegistry;

  beforeEach(() => {
    tracker = createTaskTracker();
    setTaskTracker(tracker);
    registry = createHookRegistry();
    registerBackgroundHook(registry);
  });

  test("registers task when _background metadata present", async () => {
    const ctx: PostToolUseContext = {
      toolName: "bash",
      args: {
        command: "cargo build 2>&1 | tee /tmp/mimir-build-999.log &",
        _background: {
          logPath: "/tmp/mimir-build-999.log",
          taskType: "build",
          startedAt: 999,
          originalCommand: "cargo build",
        },
      },
      toolType: "server",
      project: "/test",
      fingerprint: "test-fp",
      result: "backgrounded",
      durationMs: 10,
    };

    await registry.runPostHooks(ctx);
    expect(tracker.active("test-fp")).toHaveLength(1);
    expect(tracker.active("test-fp")[0]!.command).toBe("cargo build");
  });

  test("appends monitoring annotation to result", async () => {
    const ctx: PostToolUseContext = {
      toolName: "bash",
      args: {
        command: "cargo build 2>&1 | tee /tmp/mimir-build-999.log &",
        _background: {
          logPath: "/tmp/mimir-build-999.log",
          taskType: "build",
          startedAt: 999,
          originalCommand: "cargo build",
        },
      },
      toolType: "server",
      project: "/test",
      fingerprint: "test-fp",
      result: "ok",
      durationMs: 10,
    };

    const finalResult = await registry.runPostHooks(ctx);
    expect(typeof finalResult).toBe("string");
    expect(finalResult as string).toContain("[Background Task Started]");
    expect(finalResult as string).toContain(
      "tail -20 /tmp/mimir-build-999.log",
    );
  });

  test("does nothing without _background metadata", async () => {
    const ctx: PostToolUseContext = {
      toolName: "bash",
      args: { command: "echo hello" },
      toolType: "server",
      project: "/test",
      fingerprint: "test-fp",
      result: "hello",
      durationMs: 5,
    };

    const finalResult = await registry.runPostHooks(ctx);
    // Result unchanged — no annotation
    expect(finalResult).toBe("hello");
    expect(tracker.size).toBe(0);
  });
});
