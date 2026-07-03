import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, test } from "bun:test";
import {
  completeObservedToolCall,
  type ObservedCall,
  renderObservedToolCall,
} from "./observe-render";

type Captured = { sessionId: string; update: Record<string, unknown> };

/** Stub connection that records every sessionUpdate. */
const fakeConn = () => {
  const updates: Captured[] = [];
  const conn = {
    sessionUpdate: async (u: Captured) => {
      updates.push(u);
    },
  } as unknown as acp.AgentSideConnection;
  return { conn, updates };
};

describe("renderObservedToolCall", () => {
  test("TodoWrite renders a plan update, not a tool card", async () => {
    const { conn, updates } = fakeConn();
    const observed = new Map<string, ObservedCall>();

    await renderObservedToolCall(
      conn,
      "s1",
      {
        type: "tool_call",
        id: "c1",
        name: "TodoWrite",
        input: { todos: [{ content: "Do the thing", status: "pending" }] },
        observeOnly: true,
      },
      observed,
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]?.update.sessionUpdate).toBe("plan");
    // TodoWrite isn't tracked as a card — no paired result to complete.
    expect(observed.size).toBe(0);
  });

  test("a normal server tool renders an in-progress card and is tracked", async () => {
    const { conn, updates } = fakeConn();
    const observed = new Map<string, ObservedCall>();

    await renderObservedToolCall(
      conn,
      "s1",
      {
        type: "tool_call",
        id: "c2",
        name: "cartographer_search",
        input: { query: "foo" },
        observeOnly: true,
      },
      observed,
    );

    expect(updates.at(-1)?.update.sessionUpdate).toBe("tool_call");
    expect(observed.has("c2")).toBe(true);
  });
});

describe("completeObservedToolCall", () => {
  test("completes a tracked card and stops tracking it", async () => {
    const { conn, updates } = fakeConn();
    const observed = new Map<string, ObservedCall>([
      ["c2", { name: "cartographer_search", kind: "search", title: "Search" }],
    ]);

    await completeObservedToolCall(
      conn,
      "s1",
      { type: "tool_result", id: "c2", output: "result text", observeOnly: true },
      observed,
    );

    expect(updates.at(-1)?.update.sessionUpdate).toBe("tool_call_update");
    expect(observed.has("c2")).toBe(false);
  });

  test("is a no-op for an untracked id (e.g. a TodoWrite result)", async () => {
    const { conn, updates } = fakeConn();
    const observed = new Map<string, ObservedCall>();

    await completeObservedToolCall(
      conn,
      "s1",
      { type: "tool_result", id: "c1", output: "", observeOnly: true },
      observed,
    );

    expect(updates).toHaveLength(0);
  });
});
