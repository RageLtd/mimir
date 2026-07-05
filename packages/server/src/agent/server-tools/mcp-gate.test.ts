/**
 * MIM-76: BUNDLED_TOOLS_ENABLED=false must prevent the Context7/Time
 * stdio children from ever spawning. The config mock flips the gate off;
 * initMcpTools must return immediately with no tools and no clients —
 * if the gate regressed, this test would hang on the bunx spawns.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("../../config", () => ({
  config: {
    bundledTools: { enabled: false },
    context7: { apiKey: "" },
  },
}));

import { getMcpTools, initMcpTools } from "./mcp";

describe("initMcpTools with bundled tools disabled", () => {
  test("returns without connecting anything", async () => {
    await initMcpTools();
    expect(Object.keys(getMcpTools())).toEqual([]);
  });
});
