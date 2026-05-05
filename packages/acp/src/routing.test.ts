import { test, expect, describe } from "bun:test";
import {
  CC_PREFIX,
  COPILOT_PREFIX,
  composeServerModelName,
  isCCModel,
  isCopilotModel,
  getCCModelFlag,
  getCopilotModelFlag,
  getCCModelList,
  mergeModels,
  prettifyModelSuffix,
  titlecaseProviderId,
} from "./routing";
import type { CCBackendConfig } from "./config";

// ── CC routing ──

describe("isCCModel", () => {
  test("returns true for claude-code/ prefixed models", () => {
    expect(isCCModel("claude-code/opus")).toBe(true);
    expect(isCCModel("claude-code/sonnet")).toBe(true);
  });

  test("returns false for non-CC models", () => {
    expect(isCCModel("gpt-4o")).toBe(false);
    expect(isCCModel("copilot/gpt-4o")).toBe(false);
    expect(isCCModel("")).toBe(false);
  });

  test("prefix is exact — no partial matches", () => {
    expect(isCCModel("claude-code-wrong/opus")).toBe(false);
  });
});

describe("getCCModelFlag", () => {
  const cc: CCBackendConfig = {
    enabled: true,
    disallowedTools: [],
    permissionMode: "bypassPermissions",
    models: { opus: "claude-opus-4-20250514", sonnet: "claude-sonnet-4-20250514" },
    anchorInterval: 6,
  };

  test("maps known suffix to configured model id", () => {
    expect(getCCModelFlag(`${CC_PREFIX}opus`, cc)).toBe(
      "claude-opus-4-20250514",
    );
    expect(getCCModelFlag(`${CC_PREFIX}sonnet`, cc)).toBe(
      "claude-sonnet-4-20250514",
    );
  });

  test("falls back to suffix for unknown models", () => {
    expect(getCCModelFlag(`${CC_PREFIX}haiku`, cc)).toBe("haiku");
  });
});

describe("getCCModelList", () => {
  test("returns ModelInfo entries with `<Model> (Claude Code)` shape", () => {
    const cc: CCBackendConfig = {
      enabled: true,
      disallowedTools: [],
      permissionMode: "bypassPermissions",
      models: { "opus-4-6": "claude-opus-4-6" },
      anchorInterval: 6,
    };
    const list = getCCModelList(cc);
    expect(list).toHaveLength(1);
    expect(list[0]!.modelId).toBe("claude-code/opus-4-6");
    expect(list[0]!.name).toBe("Opus 4.6 (Claude Code)");
  });

  test("surfaces the 1M long-context variant with bracket model id", () => {
    const cc: CCBackendConfig = {
      enabled: true,
      disallowedTools: [],
      permissionMode: "bypassPermissions",
      models: { "opus-4-6-1m": "claude-opus-4-6[1m]" },
      anchorInterval: 6,
    };
    const list = getCCModelList(cc);
    expect(list).toHaveLength(1);
    expect(list[0]!.modelId).toBe("claude-code/opus-4-6-1m");
    expect(list[0]!.name).toBe("Opus 4.6 1M (Claude Code)");
    expect(list[0]!.description).toContain("claude-opus-4-6[1m]");
  });

  test("returns empty list when disabled", () => {
    const cc: CCBackendConfig = {
      enabled: false,
      disallowedTools: [],
      permissionMode: "bypassPermissions",
      models: { opus: "claude-opus-4-20250514" },
      anchorInterval: 6,
      };
    expect(getCCModelList(cc)).toEqual([]);
  });

  test("returns empty list when no models configured", () => {
    const cc: CCBackendConfig = {
      enabled: true,
      disallowedTools: [],
      permissionMode: "bypassPermissions",
      models: {},
      anchorInterval: 6,
      };
    expect(getCCModelList(cc)).toEqual([]);
  });
});

// ── Copilot routing ──

describe("isCopilotModel", () => {
  test("returns true for copilot/ prefixed models", () => {
    expect(isCopilotModel("copilot/gpt-4o")).toBe(true);
    expect(isCopilotModel("copilot/claude-sonnet-4")).toBe(true);
  });

  test("returns false for non-Copilot models", () => {
    expect(isCopilotModel("gpt-4o")).toBe(false);
    expect(isCopilotModel("claude-code/opus")).toBe(false);
    expect(isCopilotModel("")).toBe(false);
  });

  test("prefix is exact — no partial matches", () => {
    expect(isCopilotModel("copilot-wrong/gpt-4o")).toBe(false);
  });
});

describe("getCopilotModelFlag", () => {
  test("returns SDK model id from discovered map", () => {
    const discovered = new Map([["gpt-4o", "gpt-4o"]]);
    expect(getCopilotModelFlag(`${COPILOT_PREFIX}gpt-4o`, discovered)).toBe(
      "gpt-4o",
    );
  });

  test("falls back to suffix for undiscovered models", () => {
    const discovered = new Map<string, string>();
    expect(
      getCopilotModelFlag(`${COPILOT_PREFIX}unknown-model`, discovered),
    ).toBe("unknown-model");
  });
});

// ── mergeModels ──

describe("mergeModels", () => {
  test("CC and Copilot models come before server models", () => {
    const server = [{ modelId: "s1", name: "Server 1" }];
    const cc = [{ modelId: "claude-code/opus", name: "CC Opus" }];
    const copilot = [{ modelId: "copilot/gpt-4o", name: "Copilot GPT-4o" }];
    const merged = mergeModels(server, cc, copilot);
    expect(merged[0]!.modelId).toBe("claude-code/opus");
    expect(merged[1]!.modelId).toBe("copilot/gpt-4o");
    expect(merged[2]!.modelId).toBe("s1");
  });

  test("handles empty copilot list", () => {
    const server = [{ modelId: "s1", name: "Server 1" }];
    const cc = [{ modelId: "claude-code/opus", name: "CC Opus" }];
    const merged = mergeModels(server, cc);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.modelId).toBe("claude-code/opus");
    expect(merged[1]!.modelId).toBe("s1");
  });

  test("handles all empty lists", () => {
    expect(mergeModels([], [], [])).toEqual([]);
  });

  test("preserves order within each group", () => {
    const cc = [
      { modelId: "claude-code/a", name: "A" },
      { modelId: "claude-code/b", name: "B" },
    ];
    const copilot = [
      { modelId: "copilot/x", name: "X" },
      { modelId: "copilot/y", name: "Y" },
    ];
    const server = [{ modelId: "s1", name: "S1" }];
    const merged = mergeModels(server, cc, copilot);
    expect(merged.map((m) => m.modelId)).toEqual([
      "claude-code/a",
      "claude-code/b",
      "copilot/x",
      "copilot/y",
      "s1",
    ]);
  });
});

// ── Server model display ──

describe("prettifyModelSuffix", () => {
  test("dashes between digits become dots; suffix words titlecase", () => {
    expect(prettifyModelSuffix("opus-4-6")).toBe("Opus 4.6");
    expect(prettifyModelSuffix("opus-4-7")).toBe("Opus 4.7");
    expect(prettifyModelSuffix("sonnet-4-6")).toBe("Sonnet 4.6");
  });

  test("single-word suffixes get titlecased", () => {
    expect(prettifyModelSuffix("opusplan")).toBe("Opusplan");
    expect(prettifyModelSuffix("haiku")).toBe("Haiku");
  });

  test("digit+letter unit tokens are fully uppercased", () => {
    expect(prettifyModelSuffix("opus-4-6-1m")).toBe("Opus 4.6 1M");
    expect(prettifyModelSuffix("sonnet-200k")).toBe("Sonnet 200K");
  });

  test("underscores split too", () => {
    expect(prettifyModelSuffix("foo_bar")).toBe("Foo Bar");
  });

  test("empty string round-trips empty", () => {
    expect(prettifyModelSuffix("")).toBe("");
  });
});

describe("titlecaseProviderId", () => {
  test("titlecases dash-separated provider ids", () => {
    expect(titlecaseProviderId("opencode-go")).toBe("Opencode Go");
    expect(titlecaseProviderId("openrouter")).toBe("Openrouter");
  });

  test("titlecases underscore-separated ids", () => {
    expect(titlecaseProviderId("ollama_cloud")).toBe("Ollama Cloud");
  });

  test("handles empty parts gracefully", () => {
    expect(titlecaseProviderId("--")).toBe("  ");
  });
});

describe("composeServerModelName", () => {
  test("display + provider when both present", () => {
    expect(
      composeServerModelName({
        id: "glm-4.6",
        display_name: "GLM 4.6",
        owned_by: "opencode-go",
        provider_name: "OpenCode Go",
      }),
    ).toBe("GLM 4.6 (OpenCode Go)");
  });

  test("falls back to titlecasing owned_by when provider_name missing", () => {
    expect(
      composeServerModelName({
        id: "glm-4.6",
        display_name: "GLM 4.6",
        owned_by: "opencode-go",
      }),
    ).toBe("GLM 4.6 (Opencode Go)");
  });

  test("uses id when display_name missing", () => {
    expect(
      composeServerModelName({
        id: "raw-model-id",
        owned_by: "openrouter",
        provider_name: "OpenRouter",
      }),
    ).toBe("raw-model-id (OpenRouter)");
  });

  test("returns just display when no owned_by", () => {
    expect(
      composeServerModelName({
        id: "x",
        display_name: "X Display",
      }),
    ).toBe("X Display");
  });

  test("falls back to id when nothing else is present", () => {
    expect(composeServerModelName({ id: "raw" })).toBe("raw");
  });
});
