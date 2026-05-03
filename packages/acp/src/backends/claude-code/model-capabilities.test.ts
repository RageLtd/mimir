import { beforeEach, describe, expect, test } from "bun:test";
import {
  resetModelCapabilitiesForTests,
  setModelCapabilities,
  supportedEffortLevels,
  supportsAdaptiveThinking,
} from "./model-capabilities";

describe("model-capabilities", () => {
  beforeEach(() => {
    resetModelCapabilitiesForTests();
  });

  test("supportsAdaptiveThinking returns undefined before any population", () => {
    expect(supportsAdaptiveThinking("opus")).toBeUndefined();
  });

  test("supportsAdaptiveThinking returns true for a model flagged capable", () => {
    setModelCapabilities([
      { value: "opus", supportsAdaptiveThinking: true },
      { value: "sonnet", supportsAdaptiveThinking: true },
    ]);
    expect(supportsAdaptiveThinking("opus")).toBe(true);
    expect(supportsAdaptiveThinking("sonnet")).toBe(true);
  });

  test("supportsAdaptiveThinking returns false for a model explicitly lacking the capability", () => {
    setModelCapabilities([
      { value: "sonnet-4-5", supportsAdaptiveThinking: false },
    ]);
    expect(supportsAdaptiveThinking("sonnet-4-5")).toBe(false);
  });

  test("missing supportsAdaptiveThinking flag on the SDK entry is treated as false", () => {
    // The SDK's ModelInfo has supportsAdaptiveThinking as an optional field.
    // An undefined value means "not advertised as capable" — conservative.
    setModelCapabilities([{ value: "legacy-model" }]);
    expect(supportsAdaptiveThinking("legacy-model")).toBe(false);
  });

  test("supportsAdaptiveThinking returns undefined for aliases not in the catalogue", () => {
    setModelCapabilities([
      { value: "opus", supportsAdaptiveThinking: true },
    ]);
    expect(supportsAdaptiveThinking("haiku")).toBeUndefined();
  });

  test("supportsAdaptiveThinking returns undefined for an undefined model input", () => {
    setModelCapabilities([
      { value: "opus", supportsAdaptiveThinking: true },
    ]);
    expect(supportsAdaptiveThinking(undefined)).toBeUndefined();
  });

  test("variant suffixes like [1m] strip to the base alias for lookup", () => {
    setModelCapabilities([
      { value: "opus", supportsAdaptiveThinking: true },
      { value: "sonnet", supportsAdaptiveThinking: true },
    ]);
    expect(supportsAdaptiveThinking("opus[1m]")).toBe(true);
    expect(supportsAdaptiveThinking("sonnet[1m]")).toBe(true);
  });

  test("setModelCapabilities replaces prior entries rather than merging", () => {
    setModelCapabilities([
      { value: "opus", supportsAdaptiveThinking: true },
    ]);
    setModelCapabilities([
      { value: "sonnet", supportsAdaptiveThinking: true },
    ]);
    expect(supportsAdaptiveThinking("opus")).toBeUndefined();
    expect(supportsAdaptiveThinking("sonnet")).toBe(true);
  });

  test("supportedEffortLevels returns the advertised levels for a known model", () => {
    setModelCapabilities([
      {
        value: "opus",
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
    ]);
    expect(supportedEffortLevels("opus")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("supportedEffortLevels returns an empty array when the model lacks the capability", () => {
    setModelCapabilities([{ value: "haiku" }]);
    expect(supportedEffortLevels("haiku")).toEqual([]);
  });

  test("supportedEffortLevels strips variant suffixes before lookup", () => {
    setModelCapabilities([
      {
        value: "opus",
        supportedEffortLevels: ["high", "xhigh", "max"],
      },
    ]);
    expect(supportedEffortLevels("opus[1m]")).toEqual(["high", "xhigh", "max"]);
  });

  test("supportedEffortLevels returns empty for unknown aliases or undefined input", () => {
    setModelCapabilities([
      { value: "opus", supportedEffortLevels: ["high"] },
    ]);
    expect(supportedEffortLevels("unknown")).toEqual([]);
    expect(supportedEffortLevels(undefined)).toEqual([]);
  });

  // ── Family fallback ──────────────────────────────────────────────
  // User-extras (`opus-4-6`, `claude-opus-4-7`, `opusplan`) inherit
  // capabilities from the SDK base alias for their family when the
  // direct lookup misses. This is what makes the thought-level
  // selector show up for hand-added model entries.

  test("family fallback: opus-4-6 inherits from `opus` when present", () => {
    setModelCapabilities([
      {
        value: "opus",
        supportsAdaptiveThinking: true,
        supportedEffortLevels: ["high", "xhigh", "max"],
      },
    ]);
    expect(supportsAdaptiveThinking("opus-4-6")).toBe(true);
    expect(supportedEffortLevels("opus-4-6")).toEqual([
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("family fallback: opus-4-6 inherits from `default` when SDK uses that key", () => {
    // Reflects the current SDK reality — `supportedModels()` returns
    // `default` for the latest opus, not `opus`.
    setModelCapabilities([
      {
        value: "default",
        supportsAdaptiveThinking: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
    ]);
    expect(supportsAdaptiveThinking("opus-4-6")).toBe(true);
    expect(supportedEffortLevels("opus-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("family fallback: full model id (claude-opus-4-7) resolves to opus", () => {
    setModelCapabilities([
      {
        value: "default",
        supportsAdaptiveThinking: true,
        supportedEffortLevels: ["high", "xhigh", "max"],
      },
    ]);
    expect(supportedEffortLevels("claude-opus-4-7")).toEqual([
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("family fallback: opusplan maps to the opus family", () => {
    setModelCapabilities([
      {
        value: "default",
        supportsAdaptiveThinking: true,
        supportedEffortLevels: ["high", "xhigh", "max"],
      },
    ]);
    expect(supportedEffortLevels("opusplan")).toEqual([
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("family fallback: sonnet-4-6 inherits from `sonnet`", () => {
    setModelCapabilities([
      {
        value: "sonnet",
        supportsAdaptiveThinking: true,
        supportedEffortLevels: ["low", "medium", "high", "max"],
      },
    ]);
    expect(supportedEffortLevels("sonnet-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(supportedEffortLevels("claude-sonnet-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  test("family fallback: aliases with no recognised family return empty", () => {
    setModelCapabilities([
      {
        value: "opus",
        supportedEffortLevels: ["high"],
      },
    ]);
    expect(supportedEffortLevels("claude-2")).toEqual([]);
    expect(supportsAdaptiveThinking("claude-2")).toBeUndefined();
  });

  test("family fallback: returns empty when the family's base alias isn't cached either", () => {
    // Cache has sonnet only; a user-extra in the opus family with no
    // opus or default cached should report no capabilities.
    setModelCapabilities([
      {
        value: "sonnet",
        supportedEffortLevels: ["high"],
      },
    ]);
    expect(supportedEffortLevels("opus-4-6")).toEqual([]);
    expect(supportsAdaptiveThinking("opus-4-6")).toBeUndefined();
  });
});
