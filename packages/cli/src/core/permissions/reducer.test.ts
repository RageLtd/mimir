import { describe, expect, test } from "bun:test";
import { INITIAL_PERMISSIONS, permissionsReducer } from "./reducer.ts";
import type { PermissionRequest } from "./rules.ts";

const bash = (id: string, command: string): PermissionRequest => ({
  id,
  toolName: "Bash",
  input: { command },
});

const ready = { ...INITIAL_PERMISSIONS, status: "ready" as const };

describe("permissionsReducer", () => {
  test("requests queue in order and answers remove them", () => {
    let state = permissionsReducer(ready, {
      type: "permission/requested",
      request: bash("1", "ls"),
    });
    state = permissionsReducer(state, {
      type: "permission/requested",
      request: bash("2", "pwd"),
    });
    expect(state.pending.map((r) => r.id)).toEqual(["1", "2"]);
    state = permissionsReducer(state, {
      type: "permission/answered",
      id: "1",
      decision: "allow",
    });
    expect(state.pending.map((r) => r.id)).toEqual(["2"]);
    expect(state.rules).toEqual([]);
    expect(state.dirty).toBe(false);
  });

  test("allow-always on a simple command adds a rule and marks dirty", () => {
    let state = permissionsReducer(ready, {
      type: "permission/requested",
      request: bash("1", "git status"),
    });
    state = permissionsReducer(state, {
      type: "permission/answered",
      id: "1",
      decision: "allow-always",
    });
    expect(state.rules).toEqual([{ tool: "Bash", command: "git status" }]);
    expect(state.dirty).toBe(true);
    expect(state.pending).toEqual([]);
  });

  test("allow-always on a compound command adds nothing", () => {
    let state = permissionsReducer(ready, {
      type: "permission/requested",
      request: bash("1", "ls | head"),
    });
    state = permissionsReducer(state, {
      type: "permission/answered",
      id: "1",
      decision: "allow-always",
    });
    expect(state.rules).toEqual([]);
    expect(state.dirty).toBe(false);
  });

  test("duplicate rules are not added twice", () => {
    const withRule = { ...ready, rules: [{ tool: "Bash", command: "ls" }] };
    let state = permissionsReducer(withRule, {
      type: "permission/requested",
      request: bash("1", "ls"),
    });
    state = permissionsReducer(state, {
      type: "permission/answered",
      id: "1",
      decision: "allow-always",
    });
    expect(state.rules).toHaveLength(1);
    expect(state.dirty).toBe(false);
  });

  test("cancelled requests are dropped", () => {
    let state = permissionsReducer(ready, {
      type: "permission/requested",
      request: bash("1", "ls"),
    });
    state = permissionsReducer(state, {
      type: "permission/cancelled",
      id: "1",
    });
    expect(state.pending).toEqual([]);
  });

  test("load / save lifecycle", () => {
    let state = permissionsReducer(INITIAL_PERMISSIONS, {
      type: "permissions/loaded",
      rules: [{ tool: "Read" }],
    });
    expect(state.status).toBe("ready");
    expect(state.rules).toEqual([{ tool: "Read" }]);
    state = permissionsReducer(
      { ...state, dirty: true },
      { type: "permissions/saved" },
    );
    expect(state.dirty).toBe(false);
    expect(
      permissionsReducer(INITIAL_PERMISSIONS, {
        type: "permissions/load-failed",
        error: "x",
      }).status,
    ).toBe("error");
  });
});
