import { describe, expect, test } from "bun:test";
import { roleForAgentType, workerByName } from "./roles";

describe("workerByName", () => {
  test("resolves a bare worker name", () => {
    expect(workerByName("mimir-test")?.role).toBe("test");
  });

  test("resolves a plugin-prefixed name (Claude Code ships agents as <plugin>:<name>)", () => {
    expect(workerByName("mimir-cc:mimir-test")?.role).toBe("test");
    expect(workerByName("mimir-cc:mimir-impl")?.role).toBe("impl");
    expect(workerByName("mimir-cc:mimir-review")?.role).toBe("review");
  });

  test("unknown names stay unknown, prefixed or not", () => {
    expect(workerByName("Explore")).toBeNull();
    expect(workerByName("some-plugin:Explore")).toBeNull();
  });
});

describe("roleForAgentType", () => {
  test("prefixed worker types get their own role, not the impl fallback", () => {
    expect(roleForAgentType("mimir-cc:mimir-test")).toBe("test");
    expect(roleForAgentType("mimir-cc:mimir-review")).toBe("review");
  });

  test("unknown and missing types fall back to impl", () => {
    expect(roleForAgentType("claude-code-guide")).toBe("impl");
    expect(roleForAgentType(undefined)).toBe("impl");
  });
});
