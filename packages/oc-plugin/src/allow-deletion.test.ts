/**
 * The coordinator's allowed test-file deletions on OpenCode:
 * `mimir_delegate` action `allow-deletion` records them on the current
 * task, `status` shows them, the task boundary ends them, and the worker
 * gate on the coordinator's `subagent` result honours them. Real git
 * repository; the gate's toolchain commands are intercepted so only git
 * runs.
 */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCoordinatorState } from "@mimir/plugin-core/guard";
import {
  type CommandRunner,
  runCommand,
  runVerify,
} from "@mimir/plugin-core/verify";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { delegateTool } from "./delegate-tools";
import { gateTaskOutput } from "./worker-hooks";

const COORDINATOR = "coordinator-session";
const WORKER_SESSION = "worker-session";
// Neither path is a substring of the other.
const FIRST = "pkg/first.test.ts";
const SECOND = "pkg/second.test.ts";
const ADD_TEST = "add_test.go";
const SUB_TEST = "sub_test.go";
const ALLOWED_TWO = "Allowed test deletions (2)";

const dirs: string[] = [];
const savedHome = process.env.MIMIR_HOME;
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mimir-oc-allow-"));
  dirs.push(home);
  process.env.MIMIR_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedHome;
});
afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const contextFor = (sessionID: string, agent: string) => {
  const context: ToolContext = {
    ...JSON.parse(
      JSON.stringify({ sessionID, messageID: "m", agent, id: "c" }),
    ),
    signal: new AbortController().signal,
    progress: async () => {},
  };
  return context;
};
const coordinator = contextFor(COORDINATOR, "mimir");
const worker = contextFor(WORKER_SESSION, "mimir-test");

const git = async (cwd: string, ...args: string[]) => {
  const result = await runCommand(["git", ...args], cwd);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
};

const goTest = (name: string, check: string) =>
  `func ${name}(t *testing.T) {\n\tif ${check} {\n\t\tt.Fatal("${name}")\n\t}\n}`;
const goFile = (...tests: string[]) =>
  ["package x", 'import "testing"', ...tests, ""].join("\n");

/**
 * A repository with two Go test files, and an active delegation whose
 * plan lives outside it (an untracked plan would be part of the change).
 */
const seedDelegation = async () => {
  const root = join(home, "repo");
  await git(home, "init", "-q", "-b", "main", root);
  await git(root, "config", "user.email", "fixture@example.invalid");
  await git(root, "config", "user.name", "fixture");
  await Bun.write(join(root, "go.mod"), "module x\n");
  await Bun.write(
    join(root, "math.go"),
    "package x\nfunc Add(a, b int) int { return a + b }\nfunc Sub(a, b int) int { return a - b }\n",
  );
  await Bun.write(
    join(root, ADD_TEST),
    goFile(goTest("TestAdd", "Add(1, 2) != 3")),
  );
  await Bun.write(
    join(root, SUB_TEST),
    goFile(goTest("TestSub", "Sub(3, 1) != 2")),
  );
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "base");
  const planFile = join(home, "plan.md");
  await Bun.write(planFile, "# Plan\n");
  const delegate = delegateTool(root);
  const run = async (input: Record<string, unknown>, context = coordinator) =>
    (await delegate.execute(input, context)).content;
  expect(await run({ action: "start", planFile })).toContain(
    "delegation active",
  );
  return { root, planFile, run };
};

/** The worker folds both test files into math_test.go, uncommitted. */
const fold = async (root: string) => {
  await Bun.write(
    join(root, "math_test.go"),
    goFile(
      goTest("TestMathAdd", "Add(1, 2) != 3"),
      goTest("TestMathSub", "Sub(3, 1) != 2"),
    ),
  );
  await rm(join(root, ADD_TEST));
  await rm(join(root, SUB_TEST));
};

const passingRunner: CommandRunner = async (argv, cwd, timeoutMs) =>
  argv[0] === "git"
    ? runCommand(argv, cwd, timeoutMs)
    : { code: 0, stdout: "", stderr: "", timedOut: false };

/** A test worker's hand-back reaching the coordinator's `subagent` result. */
const handBack = async (root: string, child: string) => {
  const output = { output: "STATUS: done", metadata: { sessionID: child } };
  const kind = await gateTaskOutput(
    {
      tool: "subagent",
      callID: child,
      sessionID: COORDINATOR,
      args: { agent: "mimir-test" },
    },
    output,
    root,
    {
      verify: (options) => runVerify({ ...options, run: passingRunner }),
      commandTimeoutMs: 10_000,
    },
  );
  return { kind, text: output.output };
};

const deletedLine = (path: string) => `${path}: test file deleted`;

const allowed = async () =>
  (await readCoordinatorState(COORDINATOR))?.task?.allowedDeletions ?? [];

test("the tool declares allow-deletion and an optional paths array", () => {
  const delegate = delegateTool("/project");
  expect(delegate.input.required).toEqual(["action"]);
  expect(delegate.input.properties.action).toMatchObject({
    enum: expect.arrayContaining(["allow-deletion"]),
  });
  expect(delegate.input.properties).toMatchObject({
    paths: { type: "array", items: { type: "string" } },
  });
});

test("records the paths for the current task, adds on a second call, and status shows them", async () => {
  const { run } = await seedDelegation();
  await run({ action: "task" });

  await run({ action: "allow-deletion", paths: [FIRST] });
  expect(await allowed()).toEqual([FIRST]);
  const partial = await run({ action: "status" });
  expect(partial).toContain(FIRST);
  expect(partial).not.toContain(SECOND);

  await run({ action: "allow-deletion", paths: [SECOND] });
  expect([...(await allowed())].sort()).toEqual([FIRST, SECOND]);
  const shown = await run({ action: "status" });
  expect(shown).toContain(FIRST);
  expect(shown).toContain(SECOND);
});

test("capturing the next task allows nothing", async () => {
  const { run } = await seedDelegation();
  await run({ action: "task" });
  await run({ action: "allow-deletion", paths: [FIRST, SECOND] });
  expect([...(await allowed())].sort()).toEqual([FIRST, SECOND]);

  await run({ action: "task" });
  expect(await allowed()).toEqual([]);
  expect(await run({ action: "status" })).not.toContain(FIRST);
});

test("starting a different plan allows nothing", async () => {
  const { run } = await seedDelegation();
  await run({ action: "task" });
  await run({ action: "allow-deletion", paths: [FIRST] });
  expect(await allowed()).toEqual([FIRST]);

  const nextPlan = join(home, "next-plan.md");
  await Bun.write(nextPlan, "# Next plan\n");
  await run({ action: "start", planFile: nextPlan });
  await run({ action: "task" });
  expect(await allowed()).toEqual([]);
  expect(await run({ action: "status" })).not.toContain(FIRST);
});

test("stop allows nothing, including after the delegation starts again", async () => {
  const { run, planFile } = await seedDelegation();
  await run({ action: "task" });
  await run({ action: "allow-deletion", paths: [FIRST] });
  expect(await allowed()).toEqual([FIRST]);

  await run({ action: "stop" });
  expect(await readCoordinatorState(COORDINATOR)).toBeNull();
  await run({ action: "start", planFile });
  await run({ action: "task" });
  expect(await allowed()).toEqual([]);
  expect(await run({ action: "status" })).not.toContain(FIRST);
});

test("no paths: records nothing and says the paths are missing", async () => {
  const { run } = await seedDelegation();
  await run({ action: "task" });

  for (const input of [
    { action: "allow-deletion" },
    { action: "allow-deletion", paths: [] },
  ]) {
    const refused = await run(input);
    expect(refused).toContain("allow-deletion");
    expect(refused).toContain("paths");
  }
  expect(await allowed()).toEqual([]);
});

test("no active delegation: records nothing and says so", async () => {
  const delegate = delegateTool(home);
  const refused = await delegate.execute(
    { action: "allow-deletion", paths: [FIRST] },
    coordinator,
  );
  expect(refused.content).toContain("active delegation");
  expect(await readCoordinatorState(COORDINATOR)).toBeNull();
});

test("a delegation without a task boundary: records nothing and names the task action", async () => {
  const { run } = await seedDelegation();

  const refused = await run({ action: "allow-deletion", paths: [FIRST] });
  expect(refused).toContain("task boundary");
  expect((await readCoordinatorState(COORDINATOR))?.task).toBeUndefined();

  await run({ action: "task" });
  expect(await allowed()).toEqual([]);
});

test("a worker's session cannot grant the allowance and is told it is the coordinator's call", async () => {
  const { run } = await seedDelegation();
  await run({ action: "task" });
  await run({ action: "allow-deletion", paths: [FIRST] });

  const refused = await run(
    { action: "allow-deletion", paths: [SECOND] },
    worker,
  );
  expect(refused).toContain("coordinator");
  expect(await allowed()).toEqual([FIRST]);
  expect(await run({ action: "status" })).not.toContain(SECOND);
});

test("the gate honours the task's allowed deletions, blocks the rest, and the next task allows nothing", async () => {
  const { root, run } = await seedDelegation();
  await run({ action: "task" });
  await fold(root);

  const none = await handBack(root, "child-none");
  expect(none.kind).toBe("block");
  expect(none.text).toContain(deletedLine(ADD_TEST));
  expect(none.text).toContain(deletedLine(SUB_TEST));

  await run({ action: "allow-deletion", paths: [ADD_TEST] });
  const partial = await handBack(root, "child-partial");
  expect(partial.kind).toBe("block");
  expect(partial.text).toContain(deletedLine(SUB_TEST));
  expect(partial.text).not.toContain(deletedLine(ADD_TEST));

  await run({ action: "allow-deletion", paths: [SUB_TEST] });
  const passed = await handBack(root, "child-allowed");
  expect(passed.kind, passed.text).toBe("pass");
  expect(passed.text).toContain(ALLOWED_TWO);
  expect(passed.text).toContain(ADD_TEST);
  expect(passed.text).toContain(SUB_TEST);

  await run({ action: "task" });
  const next = await handBack(root, "child-next");
  expect(next.kind).toBe("block");
  expect(next.text).toContain(deletedLine(ADD_TEST));
  expect(next.text).toContain(deletedLine(SUB_TEST));
});

test("a worker's attempt to allow its own deletions leaves the gate blocking them", async () => {
  const { root, run } = await seedDelegation();
  await run({ action: "task" });
  await fold(root);

  await run({ action: "allow-deletion", paths: [ADD_TEST, SUB_TEST] }, worker);
  const blocked = await handBack(root, "child-self");
  expect(blocked.kind).toBe("block");
  expect(blocked.text).toContain(deletedLine(ADD_TEST));
  expect(blocked.text).toContain(deletedLine(SUB_TEST));
});
