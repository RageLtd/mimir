/**
 * MIM-76: web_search registers only when it can work. The module-level
 * externalTools export is config-derived at import time, so the gate
 * logic lives in buildExternalTools where both states are testable.
 */

import { describe, expect, test } from "bun:test";

import { buildExternalTools } from "./external";

describe("buildExternalTools (MIM-76 gating)", () => {
  test("enabled → web_search is registered", () => {
    expect(Object.keys(buildExternalTools(true))).toEqual(["web_search"]);
  });

  test("disabled → no stub tool, the set is empty", () => {
    expect(Object.keys(buildExternalTools(false))).toEqual([]);
  });
});
