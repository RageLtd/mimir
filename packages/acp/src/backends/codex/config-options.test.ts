import { describe, expect, test } from "bun:test";
import {
  buildCodexConfigOptions,
  DEFAULT_CODEX_MODE,
  DEFAULT_CODEX_THOUGHT_LEVEL,
  isValidCodexMode,
  isValidCodexThoughtLevel,
  resolveCodexMode,
} from "./config-options";

describe("Codex config options", () => {
  test("defaults to workspace-write with untrusted-command approvals", () => {
    const mode = resolveCodexMode(undefined);
    expect(mode.id).toBe(DEFAULT_CODEX_MODE);
    expect(mode.sandboxMode).toBe("workspace-write");
    expect(mode.approvalPolicy).toBe("untrusted");
  });

  test("validates modes", () => {
    expect(isValidCodexMode("default")).toBe(true);
    expect(isValidCodexMode("read-only")).toBe(true);
    expect(isValidCodexMode("auto")).toBe(true);
    expect(isValidCodexMode("danger")).toBe(false);
  });

  test("validates thought levels", () => {
    expect(isValidCodexThoughtLevel("minimal")).toBe(true);
    expect(isValidCodexThoughtLevel("xhigh")).toBe(true);
    expect(isValidCodexThoughtLevel("none")).toBe(false);
  });

  test("builds mode and thought-level selectors", () => {
    const options = buildCodexConfigOptions({});
    expect(options).toHaveLength(2);
    expect(options[0]!.id).toBe("mode");
    expect(options[0]!.currentValue).toBe(DEFAULT_CODEX_MODE);
    expect(options[1]!.id).toBe("thought_level");
    expect(options[1]!.currentValue).toBe(DEFAULT_CODEX_THOUGHT_LEVEL);
  });
});
