import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowTaskDeletions,
  allowTaskRemovals,
  clearCoordinatorState,
  coordinatorStatePath,
  readCoordinatorState,
  writeCoordinatorState,
} from "./coordinator-state";

const dirs: string[] = [];
const savedHome = process.env.MIMIR_HOME;

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "mimir-coord-"));
  dirs.push(home);
  process.env.MIMIR_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedHome;
});

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("coordinator state", () => {
  test("task base round-trips across readers; malformed task state fails closed", async () => {
    const state = {
      active: true,
      planFile: "/plan",
      task: { base: "a".repeat(40), worktree: "/repo" },
    };
    await writeCoordinatorState("task", state);
    expect(await readCoordinatorState("task")).toEqual(state);
    await Bun.write(
      coordinatorStatePath("task"),
      JSON.stringify({ ...state, task: { base: 123 } }),
    );
    await expect(readCoordinatorState("task")).rejects.toThrow(
      "Invalid coordinator task state",
    );
  });

  test("absent → null; write → read round-trips; clear → null", async () => {
    expect(await readCoordinatorState("s1")).toBeNull();
    await writeCoordinatorState("s1", { active: true, planFile: "/p/plan.md" });
    expect(await readCoordinatorState("s1")).toEqual({
      active: true,
      planFile: "/p/plan.md",
    });
    await clearCoordinatorState("s1");
    expect(await readCoordinatorState("s1")).toBeNull();
  });

  test("malformed or wrong-shaped file → null, never throws", async () => {
    await Bun.write(coordinatorStatePath("s2"), "{not json");
    expect(await readCoordinatorState("s2")).toBeNull();
    await Bun.write(
      coordinatorStatePath("s3"),
      JSON.stringify({ active: "yes" }),
    );
    expect(await readCoordinatorState("s3")).toBeNull();
  });

  describe("test files allowed to lose assertions", () => {
    const FIRST = "src/a.test.ts";
    const SECOND = "pkg/b_test.go";
    const GONE = "pkg/gone_test.go";
    const INVALID_TASK = "Invalid coordinator task state";
    const task = { base: "b".repeat(40), worktree: "/repo" };
    const state = { active: true, planFile: "/plan", task };

    const readTask = async (session: string) => {
      const read = await readCoordinatorState(session);
      if (!read?.task) throw new Error(`no task state for ${session}`);
      return { ...read, task: read.task };
    };

    test("adding allowed removals keeps the earlier ones, without duplicates", async () => {
      await writeCoordinatorState("removals", state);
      expect(
        await allowTaskRemovals("removals", await readTask("removals"), [
          FIRST,
        ]),
      ).toEqual([FIRST]);
      expect(
        await allowTaskRemovals("removals", await readTask("removals"), [
          SECOND,
          FIRST,
        ]),
      ).toEqual([FIRST, SECOND]);
      expect((await readTask("removals")).task.allowedRemovals).toEqual([
        FIRST,
        SECOND,
      ]);
    });

    test("allowed removals read back with the rest of the task state", async () => {
      const withRemovals = {
        ...state,
        task: { ...task, allowedDeletions: [GONE], allowedRemovals: [FIRST] },
      };
      await writeCoordinatorState("removals-read", withRemovals);
      expect(await readCoordinatorState("removals-read")).toEqual(withRemovals);
    });

    test("malformed allowed removals refuse to read", async () => {
      for (const allowedRemovals of [FIRST, [FIRST, 7], { path: FIRST }]) {
        await Bun.write(
          coordinatorStatePath("removals-bad"),
          JSON.stringify({ ...state, task: { ...task, allowedRemovals } }),
        );
        await expect(readCoordinatorState("removals-bad")).rejects.toThrow(
          INVALID_TASK,
        );
      }
    });

    test("allowed removals are held on the task beside allowed deletions, so a new task starts without either", async () => {
      await writeCoordinatorState("removals-task", state);
      await allowTaskRemovals(
        "removals-task",
        await readTask("removals-task"),
        [FIRST],
      );
      await allowTaskDeletions(
        "removals-task",
        await readTask("removals-task"),
        [GONE],
      );
      expect(await readCoordinatorState("removals-task")).toEqual({
        ...state,
        task: { ...task, allowedDeletions: [GONE], allowedRemovals: [FIRST] },
      });

      const next = { base: "c".repeat(40), worktree: "/repo" };
      await writeCoordinatorState("removals-task", { ...state, task: next });
      expect(await readCoordinatorState("removals-task")).toEqual({
        ...state,
        task: next,
      });
    });
  });

  describe("a task marked as a refactor", () => {
    const task = { base: "d".repeat(40), worktree: "/repo" };
    const state = { active: true, planFile: "/plan", task };

    test("the refactor mark reads back with the rest of the task state", async () => {
      const marked = {
        ...state,
        task: { ...task, allowedRemovals: ["src/a.test.ts"], refactor: true },
      };
      await writeCoordinatorState("refactor-read", marked);
      expect(await readCoordinatorState("refactor-read")).toEqual(marked);
    });

    test("a refactor mark that is not a boolean refuses to read", async () => {
      for (const refactor of ["true", 1, [true]]) {
        await Bun.write(
          coordinatorStatePath("refactor-bad"),
          JSON.stringify({ ...state, task: { ...task, refactor } }),
        );
        await expect(readCoordinatorState("refactor-bad")).rejects.toThrow(
          "Invalid coordinator task state",
        );
      }
    });

    test("a new task boundary written without the mark leaves the new task unmarked", async () => {
      await writeCoordinatorState("refactor-task", {
        ...state,
        task: { ...task, refactor: true },
      });
      const next = { base: "e".repeat(40), worktree: "/repo" };
      await writeCoordinatorState("refactor-task", { ...state, task: next });
      const read = await readCoordinatorState("refactor-task");
      expect(read).toEqual({ ...state, task: next });
      expect(read?.task?.refactor).toBeUndefined();
    });
  });

  test("session ids are sanitised into a filename", () => {
    expect(coordinatorStatePath("a/b c")).toBe(
      join(process.env.MIMIR_HOME ?? "", "agents", "a_b_c.json"),
    );
  });
});
