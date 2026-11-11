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

  test("session ids are sanitised into a filename", () => {
    expect(coordinatorStatePath("a/b c")).toBe(
      join(process.env.MIMIR_HOME ?? "", "agents", "a_b_c.json"),
    );
  });
});
