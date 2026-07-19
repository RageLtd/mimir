import { describe, expect, test } from "bun:test";
import { createPushQueue } from "./push-queue";

describe("createPushQueue", () => {
  test("buffered push then pull", async () => {
    const q = createPushQueue<string>();
    q.push("a");
    q.push("b");

    const r1 = await q.iterator.next();
    expect(r1).toEqual({ value: "a", done: false });

    const r2 = await q.iterator.next();
    expect(r2).toEqual({ value: "b", done: false });
  });

  test("pull before push resolves when value arrives", async () => {
    const q = createPushQueue<number>();

    // Start waiting before any value is pushed.
    const pending = q.iterator.next();
    q.push(42);

    const result = await pending;
    expect(result).toEqual({ value: 42, done: false });
  });

  test("end signals done to a waiting consumer", async () => {
    const q = createPushQueue<string>();

    const pending = q.iterator.next();
    q.end();

    const result = await pending;
    expect(result.done).toBe(true);
  });

  test("end signals done after buffer is drained", async () => {
    const q = createPushQueue<string>();
    q.push("last");
    q.end();

    const r1 = await q.iterator.next();
    expect(r1).toEqual({ value: "last", done: false });

    const r2 = await q.iterator.next();
    expect(r2.done).toBe(true);
  });

  test("push after end is silently ignored", async () => {
    const q = createPushQueue<string>();
    q.push("before");
    q.end();
    q.push("after");

    const r1 = await q.iterator.next();
    expect(r1).toEqual({ value: "before", done: false });

    const r2 = await q.iterator.next();
    expect(r2.done).toBe(true);
  });

  test("multiple consumers would get sequential values", async () => {
    const q = createPushQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.end();

    const collected: number[] = [];
    for await (const value of q.iterator) {
      collected.push(value);
    }
    expect(collected).toEqual([1, 2, 3]);
  });

  test("for-await-of drains and terminates on end", async () => {
    const q = createPushQueue<string>();

    // Push values asynchronously.
    setTimeout(() => {
      q.push("x");
      q.push("y");
      q.end();
    }, 10);

    const collected: string[] = [];
    for await (const value of q.iterator) {
      collected.push(value);
    }
    expect(collected).toEqual(["x", "y"]);
  });

  test("immediate end yields empty iteration", async () => {
    const q = createPushQueue<string>();
    q.end();

    const result = await q.iterator.next();
    expect(result.done).toBe(true);
  });

  test("interleaved push and pull", async () => {
    const q = createPushQueue<string>();

    q.push("a");
    expect(await q.iterator.next()).toEqual({ value: "a", done: false });

    q.push("b");
    expect(await q.iterator.next()).toEqual({ value: "b", done: false });

    q.push("c");
    q.push("d");
    expect(await q.iterator.next()).toEqual({ value: "c", done: false });
    expect(await q.iterator.next()).toEqual({ value: "d", done: false });

    q.end();
    expect((await q.iterator.next()).done).toBe(true);
  });
});
