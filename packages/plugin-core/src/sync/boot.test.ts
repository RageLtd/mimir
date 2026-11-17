import { describe, expect, test } from "bun:test";
import type { Logger } from "../logger";
import { reconcileAndSync } from "./boot";

const log: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const SHORT_DEADLINE_MS = 20;
const GENEROUS_DEADLINE_MS = 5_000;

const skipped = (detail: string) => ({ status: "skipped", detail }) as const;

const never = () => new Promise<never>(() => {});

describe("reconcileAndSync", () => {
  test("runs reconcile then sync and resolves sync's result", async () => {
    const order: string[] = [];
    const outcome = await reconcileAndSync(
      { log, deadlineMs: GENEROUS_DEADLINE_MS },
      {
        reconcile: async () => {
          order.push("reconcile");
          return skipped("no keys");
        },
        sync: async () => {
          order.push("sync");
          return skipped("no server");
        },
      },
    );
    expect(order).toEqual(["reconcile", "sync"]);
    expect(outcome).toEqual(skipped("no server"));
  });

  test("sync does not start before reconcile resolves", async () => {
    let releaseReconcile = () => {};
    let syncStarted = false;
    const pending = reconcileAndSync(
      { log, deadlineMs: GENEROUS_DEADLINE_MS },
      {
        reconcile: () =>
          new Promise((resolve) => {
            releaseReconcile = () => resolve(skipped("no keys"));
          }),
        sync: async () => {
          syncStarted = true;
          return skipped("no server");
        },
      },
    );
    await Bun.sleep(5);
    expect(syncStarted).toBe(false);
    releaseReconcile();
    await pending;
    expect(syncStarted).toBe(true);
  });

  test("deadline when reconcile never finishes; sync never starts", async () => {
    let syncStarted = false;
    const outcome = await reconcileAndSync(
      { log, deadlineMs: SHORT_DEADLINE_MS },
      {
        reconcile: never,
        sync: async () => {
          syncStarted = true;
          return skipped("no server");
        },
      },
    );
    expect(outcome).toEqual({ status: "deadline" });
    expect(syncStarted).toBe(false);
  });

  test("deadline when sync never finishes", async () => {
    const outcome = await reconcileAndSync(
      { log, deadlineMs: SHORT_DEADLINE_MS },
      { reconcile: async () => skipped("no keys"), sync: never },
    );
    expect(outcome).toEqual({ status: "deadline" });
  });

  test("a rejecting reconcile rejects the call and skips sync", async () => {
    let syncStarted = false;
    const run = reconcileAndSync(
      { log, deadlineMs: GENEROUS_DEADLINE_MS },
      {
        reconcile: async () => {
          throw new Error("keyring corrupt");
        },
        sync: async () => {
          syncStarted = true;
          return skipped("no server");
        },
      },
    );
    await expect(run).rejects.toThrow("keyring corrupt");
    expect(syncStarted).toBe(false);
  });

  test("a rejecting sync rejects the call", async () => {
    const run = reconcileAndSync(
      { log, deadlineMs: GENEROUS_DEADLINE_MS },
      {
        reconcile: async () => skipped("no keys"),
        sync: async () => {
          throw new Error("server unreachable");
        },
      },
    );
    await expect(run).rejects.toThrow("server unreachable");
  });
});
