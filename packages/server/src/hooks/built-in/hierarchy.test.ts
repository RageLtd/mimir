import { describe, expect, test } from "bun:test";
import { HookRegistry } from "../registry";
import type { HookContext } from "../types";
import { registerHierarchyHook } from "./hierarchy";

function bashCtx(command: string, availableTools: string[] = []): HookContext {
  return {
    toolName: "bash",
    args: { command },
    toolType: "server",
    project: "/test",
    fingerprint: "test-fp",
    availableTools,
  };
}

function makeRegistry(): HookRegistry {
  const registry = new HookRegistry();
  registerHierarchyHook(registry);
  return registry;
}

describe("Tool Hierarchy Enforcer", () => {
  // --- Should DENY when dedicated tool exists ---

  test("warns on cat when read tool available", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("cat src/index.ts", ["bash", "read", "edit"]),
    );
    expect(result.action).toBe("allow");
    expect((result as { warning?: string }).warning).toContain("read");
  });

  test("warns on head when read tool available", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("head -20 src/index.ts", ["bash", "read"]),
    );
    expect(result.action).toBe("allow");
    expect((result as { warning?: string }).warning).toBeDefined();
  });

  test("warns on tail when read tool available", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("tail -50 src/index.ts", ["bash", "read"]),
    );
    expect(result.action).toBe("allow");
    expect((result as { warning?: string }).warning).toBeDefined();
  });

  test("warns on sed when edit tool available", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("sed -i 's/foo/bar/' file.txt", ["bash", "edit"]),
    );
    expect(result.action).toBe("allow");
    expect((result as { warning?: string }).warning).toContain("edit");
  });

  test("warns on awk when edit tool available", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("awk '{print $1}' data.csv", ["bash", "edit"]),
    );
    expect(result.action).toBe("allow");
    expect((result as { warning?: string }).warning).toBeDefined();
  });

  test("warns on grep when grep tool available", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("grep -r 'TODO' src/", ["bash", "grep"]),
    );
    expect(result.action).toBe("allow");
    expect((result as { warning?: string }).warning).toContain("grep");
  });

  test("warns on rg when search tool available", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("rg 'import' --type ts", ["bash", "search"]),
    );
    expect(result.action).toBe("allow");
    expect((result as { warning?: string }).warning).toBeDefined();
  });

  test("warns on find when glob tool available", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("find . -name '*.ts'", ["bash", "glob"]),
    );
    expect(result.action).toBe("allow");
    expect((result as { warning?: string }).warning).toBeDefined();
  });

  test("warns on ls when glob tool available", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("ls src/hooks/", ["bash", "glob"]),
    );
    expect(result.action).toBe("allow");
    expect((result as { warning?: string }).warning).toBeDefined();
  });

  test("matches Read (capitalized) as dedicated tool", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("cat file.txt", ["bash", "Read"]),
    );
    expect(result.action).toBe("allow");
    expect((result as { warning?: string }).warning).toBeDefined();
  });

  test("matches ReadFile as dedicated tool", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("cat file.txt", ["bash", "ReadFile"]),
    );
    expect(result.action).toBe("allow");
    expect((result as { warning?: string }).warning).toBeDefined();
  });

  // --- Should ALLOW when no dedicated tool exists ---

  test("allows cat when no read tool available", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("cat src/index.ts", ["bash", "edit"]),
    );
    expect(result.action).toBe("allow");
  });

  test("allows grep when no grep/search tool available", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("grep -r 'TODO' src/", ["bash", "read", "edit"]),
    );
    expect(result.action).toBe("allow");
  });

  test("allows find when no glob tool available", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("find . -name '*.ts'", ["bash", "read"]),
    );
    expect(result.action).toBe("allow");
  });

  // --- Should ALLOW non-substitutable commands ---

  test("allows cargo build", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("cargo build --release", ["bash", "read", "edit", "grep"]),
    );
    expect(result.action).toBe("allow");
  });

  test("allows git status", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("git status", ["bash", "read", "edit"]),
    );
    expect(result.action).toBe("allow");
  });

  test("allows npm test", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("npm test", ["bash", "read", "write", "glob"]),
    );
    expect(result.action).toBe("allow");
  });

  // --- Edge cases ---

  test("allows when availableTools is empty", async () => {
    const result = await makeRegistry().runPreHooks(
      bashCtx("cat file.txt", []),
    );
    expect(result.action).toBe("allow");
  });

  test("allows when availableTools is undefined", async () => {
    const ctx = bashCtx("cat file.txt", []);
    ctx.availableTools = undefined;
    const result = await makeRegistry().runPreHooks(ctx);
    expect(result.action).toBe("allow");
  });

  test("allows non-bash tools", async () => {
    const result = await makeRegistry().runPreHooks({
      toolName: "memory_search",
      args: { command: "cat something" },
      toolType: "server",
      project: "/test",
      fingerprint: "fp",
      availableTools: ["bash", "read"],
    });
    expect(result.action).toBe("allow");
  });

  test("allows when command arg is missing", async () => {
    const result = await makeRegistry().runPreHooks({
      toolName: "bash",
      args: {},
      toolType: "server",
      project: "/test",
      fingerprint: "fp",
      availableTools: ["bash", "read"],
    });
    expect(result.action).toBe("allow");
  });
});
