import { beforeEach, describe, expect, test } from "bun:test";
import {
  resetModelCapabilitiesForTests,
  setModelCapabilities,
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
});
