import { describe, expect, test } from "bun:test";
import { registerConfigSlice } from "./config/reducer.ts";
import { registerPermissionsSlice } from "./permissions/reducer.ts";
import { registerResourcesSlice } from "./resources/reducer.ts";
import type { AppState } from "./store/state.ts";
import { createStore } from "./store/store.ts";
import { registerTranscriptSlice } from "./transcript/reducer.ts";

// createApp() spawns workers, so the contract is exercised against the same
// slices wired onto a bare store: what a frontend can observe and do.
const build = () => {
  const store = createStore<AppState>();
  registerConfigSlice(store);
  registerPermissionsSlice(store);
  registerResourcesSlice(store);
  registerTranscriptSlice(store);
  return store;
};

describe("transcript as seen by a frontend", () => {
  test("lines carry raw text; no prefixes or glyphs", () => {
    const store = build();
    store.dispatch({ type: "input/submit", text: "hello" });
    store.dispatch({ type: "agent/tool-use", name: "Bash" });
    store.dispatch({ type: "agent/error", message: "boom" });
    expect(
      store.getState().transcript.lines.map((l) => [l.kind, l.text]),
    ).toEqual([
      ["user", "hello"],
      ["tool", "Bash"],
      ["error", "boom"],
    ]);
  });

  test("streaming promotes to an assistant line on block end", () => {
    const store = build();
    store.dispatch({ type: "agent/text-delta", text: "wal" });
    store.dispatch({ type: "agent/text-delta", text: "rus" });
    expect(store.getState().transcript.streaming).toBe("walrus");
    store.dispatch({ type: "agent/block-end" });
    expect(store.getState().transcript.streaming).toBeNull();
    expect(store.getState().transcript.lines.at(-1)).toMatchObject({
      kind: "assistant",
      text: "walrus",
    });
  });

  test("persistence failures surface as error lines", () => {
    const store = build();
    store.dispatch({ type: "permissions/load-failed", error: "bad" });
    store.dispatch({ type: "config/save-failed", error: "disk" });
    const texts = store.getState().transcript.lines.map((l) => l.text);
    expect(texts[0]).toStartWith("permissions: bad");
    expect(texts[1]).toBe("config save: disk");
  });
});

describe("state is plain data", () => {
  test("survives a JSON round-trip unchanged", () => {
    const store = build();
    store.dispatch({ type: "input/submit", text: "hi" });
    store.dispatch({
      type: "permission/requested",
      request: { id: "1", toolName: "Bash", input: { command: "ls" } },
    });
    const state = store.getState();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
