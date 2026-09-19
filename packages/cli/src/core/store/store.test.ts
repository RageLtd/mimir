import { describe, expect, test } from "bun:test";
import type { Action } from "./actions.ts";
import { createStore } from "./store.ts";

type CounterState = { count: number };
type LogState = { entries: string[] };
type TestState = { counter: CounterState; log: LogState };

const counter = (state: CounterState, action: Action) =>
  action.type === "agent/turn-end" ? { count: state.count + 1 } : state;

const log = (state: LogState, action: Action) =>
  action.type === "notice"
    ? { entries: [...state.entries, action.text] }
    : state;

const build = () => {
  const store = createStore<TestState>();
  store.register("counter", { count: 0 }, counter);
  store.register("log", { entries: [] }, log);
  return store;
};

describe("createStore", () => {
  test("every registered reducer sees every action", () => {
    const store = build();
    store.dispatch({ type: "agent/turn-end" });
    store.dispatch({ type: "notice", text: "hi" });
    expect(store.getState()).toEqual({
      counter: { count: 1 },
      log: { entries: ["hi"] },
    });
  });

  test("untouched slices keep their identity", () => {
    const store = build();
    const before = store.getState().log;
    store.dispatch({ type: "agent/turn-end" });
    expect(store.getState().log).toBe(before);
  });

  test("subscribers fire only when their selection changes", () => {
    const store = build();
    const seen: number[] = [];
    store.subscribe(
      (state) => state.counter.count,
      (count) => {
        seen.push(count);
      },
    );
    store.dispatch({ type: "notice", text: "ignored" });
    store.dispatch({ type: "agent/turn-end" });
    store.dispatch({ type: "agent/turn-end" });
    expect(seen).toEqual([1, 2]);
  });

  test("subscribers receive the previous value", () => {
    const store = build();
    const previous: number[] = [];
    store.subscribe(
      (state) => state.counter.count,
      (_, prev) => {
        previous.push(prev);
      },
    );
    store.dispatch({ type: "agent/turn-end" });
    expect(previous).toEqual([0]);
  });

  test("listeners see every action even when state is unchanged", () => {
    const store = build();
    const types: string[] = [];
    store.listen((action) => {
      types.push(action.type);
    });
    store.dispatch({ type: "app/quit" });
    expect(types).toEqual(["app/quit"]);
  });

  test("dispatch from inside a notification is queued, not nested", () => {
    const store = build();
    const order: string[] = [];
    store.listen((action) => {
      order.push(`listen:${action.type}`);
      if (action.type === "agent/turn-end") {
        store.dispatch({ type: "notice", text: "after" });
      }
    });
    store.subscribe(
      (state) => state.log.entries,
      () => {
        order.push("log-changed");
      },
    );
    store.dispatch({ type: "agent/turn-end" });
    expect(order).toEqual([
      "listen:agent/turn-end",
      "log-changed",
      "listen:notice",
    ]);
  });

  test("unsubscribe stops notifications", () => {
    const store = build();
    let fired = 0;
    const stop = store.subscribe(
      (state) => state.counter.count,
      () => {
        fired += 1;
      },
    );
    store.dispatch({ type: "agent/turn-end" });
    stop();
    store.dispatch({ type: "agent/turn-end" });
    expect(fired).toBe(1);
  });
});
