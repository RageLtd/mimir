import { describe, expect, test } from "bun:test";
import { runHook, runWorker } from "./session-start-hook";

describe("runHook", () => {
  test("startup and resume detach the worker and return at once", () => {
    for (const source of ["startup", "resume"] as const) {
      const spawned: string[] = [];
      const code = runHook(
        { source, cwd: "/work/repo" },
        { spawnWorker: (path) => spawned.push(path) },
      );
      expect(code).toBe(0);
      expect(spawned).toEqual(["/work/repo"]);
    }
  });

  test("a missing source means startup", () => {
    const spawned: string[] = [];
    runHook(
      { cwd: "/work/repo" },
      { spawnWorker: (path) => spawned.push(path) },
    );
    expect(spawned).toEqual(["/work/repo"]);
  });

  test("clear and compact are not a new working period — nothing spawns", () => {
    for (const source of ["clear", "compact"] as const) {
      const spawned: string[] = [];
      const code = runHook(
        { source, cwd: "/work/repo" },
        { spawnWorker: (path) => spawned.push(path) },
      );
      expect(code).toBe(0);
      expect(spawned).toEqual([]);
    }
  });
});

describe("runWorker", () => {
  test("reconciles and syncs, then reindexes", async () => {
    const order: string[] = [];
    const code = await runWorker("/work/repo", {
      reconcileAndSync: async () => {
        order.push("sync");
        return { status: "ok" };
      },
      reindex: async (path) => {
        order.push(`reindex:${path}`);
      },
    });
    expect(code).toBe(0);
    expect(order).toEqual(["sync", "reindex:/work/repo"]);
  });

  test("a failed reconcile does not stop the reindex", async () => {
    let reindexed = false;
    const code = await runWorker("/work/repo", {
      reconcileAndSync: async () => {
        throw new Error("server unreachable");
      },
      reindex: async () => {
        reindexed = true;
      },
    });
    expect(code).toBe(0);
    expect(reindexed).toBe(true);
  });
});
