import { describe, expect, test } from "bun:test";
import {
  buildCodexOptions,
  buildCodexThreadOptions,
  resolveCodexEffort,
} from "./formatting";

describe("Codex formatting", () => {
  test("builds config with replacement instruction file and MCP servers", () => {
    const opts = buildCodexOptions({
      instructionPath: "/tmp/mimir.md",
      serverUrl: "http://mimir.test",
      userMemoryDbPath: "/tmp/mem.db",
      workingDirectory: "/repo",
      clientMcpServers: [],
    });

    expect(opts.config?.model_instructions_file).toBe("/tmp/mimir.md");
    expect(opts.config?.mcp_servers).toBeDefined();
    expect("hooks" in opts.config).toBe(false);
  });

  test("builds thread options with professional default safety", () => {
    const opts = buildCodexThreadOptions({
      workingDirectory: "/repo",
      model: "gpt-5.5",
      mode: "default",
      effort: undefined,
    });

    expect(opts.model).toBe("gpt-5.5");
    expect(opts.workingDirectory).toBe("/repo");
    expect(opts.sandboxMode).toBe("workspace-write");
    expect(opts.approvalPolicy).toBe("untrusted");
    expect(opts.modelReasoningEffort).toBe("high");
  });

  test("read-only mode maps to read-only sandbox", () => {
    const opts = buildCodexThreadOptions({
      workingDirectory: "/repo",
      model: "gpt-5.5",
      mode: "read-only",
      effort: "low",
    });

    expect(opts.sandboxMode).toBe("read-only");
    expect(opts.approvalPolicy).toBe("on-request");
    expect(opts.modelReasoningEffort).toBe("low");
  });

  test("non-Codex effort falls back to default", () => {
    expect(resolveCodexEffort("none")).toBe("high");
  });
});
