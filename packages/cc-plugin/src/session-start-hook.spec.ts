import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runHook, runWorker } from "./session-start-hook";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

// Hermetic: an exported GIT_DIR/GIT_WORK_TREE or a repository above the temp
// directory must not leak into the repository the case sets up.
const gitInit = async (cwd: string) => {
  const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, ...rest } = process.env;
  const proc = Bun.spawn(["git", "init", "-q"], {
    cwd,
    env: { ...rest, GIT_CEILING_DIRECTORIES: dirname(cwd) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git init exited ${code} in ${cwd}`);
};

describe("runHook", () => {
  test("startup and resume detach the worker and return at once", async () => {
    for (const source of ["startup", "resume"] as const) {
      const spawned: string[] = [];
      const code = await runHook(
        { source, cwd: "/work/repo" },
        { spawnWorker: (path) => spawned.push(path) },
      );
      expect(code).toBe(0);
      expect(spawned).toEqual(["/work/repo"]);
    }
  });

  test("a missing source means startup", async () => {
    const spawned: string[] = [];
    await runHook(
      { cwd: "/work/repo" },
      { spawnWorker: (path) => spawned.push(path) },
    );
    expect(spawned).toEqual(["/work/repo"]);
  });

  test("clear and compact are not a new working period — nothing spawns", async () => {
    for (const source of ["clear", "compact"] as const) {
      const spawned: string[] = [];
      const code = await runHook(
        { source, cwd: "/work/repo" },
        { spawnWorker: (path) => spawned.push(path) },
      );
      expect(code).toBe(0);
      expect(spawned).toEqual([]);
    }
  });

  test("the worker receives the repository root, not the payload cwd", async () => {
    dir = await mkdtemp(join(tmpdir(), "mimir-session-start-"));
    const nested = join(dir, "a", "b");
    await mkdir(nested, { recursive: true });
    await gitInit(dir);

    const spawned: string[] = [];
    const code = await runHook(
      { source: "startup", cwd: nested },
      { spawnWorker: (path) => spawned.push(path) },
    );

    expect(code).toBe(0);
    expect(spawned).toEqual([dir]);
  });
});

describe("runWorker", () => {
  test("reconciles and syncs, sweeps the payload files left behind, then reindexes", async () => {
    const order: string[] = [];
    const code = await runWorker("/work/repo", {
      reconcileAndSync: async () => {
        order.push("sync");
        return { status: "ok" };
      },
      sweepPayloads: async () => {
        order.push("sweep");
        return { removed: 0, failures: [] };
      },
      reindex: async (path) => {
        order.push(`reindex:${path}`);
      },
    });
    expect(code).toBe(0);
    expect(order).toEqual(["sync", "sweep", "reindex:/work/repo"]);
  });

  test("a sweep that cannot remove a file does not stop the reindex", async () => {
    let reindexed = false;
    const code = await runWorker("/work/repo", {
      reconcileAndSync: async () => ({ status: "ok" }),
      sweepPayloads: async () => ({
        removed: 0,
        failures: [{ path: "/home/t/.mimir/run/a.json", error: "EACCES" }],
      }),
      reindex: async () => {
        reindexed = true;
      },
    });
    expect(code).toBe(0);
    expect(reindexed).toBe(true);
  });

  test("a failed reconcile does not stop the reindex", async () => {
    let reindexed = false;
    const code = await runWorker("/work/repo", {
      reconcileAndSync: async () => {
        throw new Error("server unreachable");
      },
      sweepPayloads: async () => ({ removed: 0, failures: [] }),
      reindex: async () => {
        reindexed = true;
      },
    });
    expect(code).toBe(0);
    expect(reindexed).toBe(true);
  });
});
