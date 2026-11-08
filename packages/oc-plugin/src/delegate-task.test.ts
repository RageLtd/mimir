import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coordinatorStatePath,
  readCoordinatorState,
  writeCoordinatorState,
} from "@mimir/plugin-core/guard";
import { runCommand } from "@mimir/plugin-core/verify";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { delegateTool, reviewPromptTool } from "./delegate-tools";
import {
  createSessionRoles,
  enforceRoleGuard,
  gateTaskOutput,
} from "./worker-hooks";

const dirs: string[] = [];
const savedHome = process.env.MIMIR_HOME;
test("nested launch defaults review to the task worktree and keeps explicit paths launch-relative", async () => {
  const root = dirs[dirs.length - 1] ?? "";
  const git = async (...args: string[]) => {
    const result = await runCommand(["git", ...args], root);
    expect(result.code).toBe(0);
    return result.stdout.trim();
  };
  await git("init", "-q");
  await git("config", "user.name", "fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await Bun.write(join(root, "value.ts"), "export const value = 0;\n");
  await git("add", "value.ts");
  await git("commit", "-qm", "base");
  await writeCoordinatorState("parent", {
    active: true,
    planFile: join(root, "plan.md"),
    task: { base: await git("rev-parse", "HEAD"), worktree: root },
  });
  await Bun.write(join(root, "value.ts"), "export const value = 1;\n");
  const context: ToolContext = {
    ...JSON.parse(
      '{"sessionID":"parent","messageID":"m","agent":"mimir","id":"c"}',
    ),
    signal: new AbortController().signal,
    progress: async () => {},
  };
  const review = reviewPromptTool(
    join(root, "nested"),
    async () => "parent",
    root,
  );
  expect((await review.execute({ title: "Value" }, context)).content).toContain(
    "value.ts",
  );
  expect(
    (await review.execute({ title: "Value", worktree: ".." }, context)).content,
  ).toContain("value.ts");
});
beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "mimir-oc-task-"));
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

test("task action refuses inactive sessions and failed capture cannot retain an old boundary", async () => {
  const root = dirs[dirs.length - 1] ?? "";
  const context: ToolContext = {
    ...JSON.parse(
      '{"sessionID":"parent","messageID":"m","agent":"mimir","id":"c"}',
    ),
    signal: new AbortController().signal,
    progress: async () => {},
  };
  const tool = delegateTool(root);
  expect((await tool.execute({ action: "task" }, context)).content).toContain(
    "active delegation",
  );
  const planFile = join(root, "plan.md");
  await Bun.write(planFile, "# Plan");
  await writeCoordinatorState("parent", { active: true, planFile });
  await expect(tool.execute({ action: "task" }, context)).rejects.toThrow(
    "Cannot capture task base",
  );
  expect((await readCoordinatorState("parent"))?.task).toBeUndefined();
  await writeCoordinatorState("parent", {
    active: true,
    planFile,
    task: { base: "a".repeat(40), worktree: root },
  });
  await expect(tool.execute({ action: "task" }, context)).rejects.toThrow(
    "Cannot capture task base",
  );
  expect((await readCoordinatorState("parent"))?.task).toBeUndefined();
});

test("utility agents dispatch and return without a task boundary; only Mimir's workers need one", async () => {
  const root = dirs[dirs.length - 1] ?? "";
  const planFile = join(root, "plan.md");
  await Bun.write(planFile, "# Plan");
  await writeCoordinatorState("parent", { active: true, planFile });
  const roles = createSessionRoles(async () => ({}));
  const input = { tool: "subagent", sessionID: "parent" };
  await expect(
    enforceRoleGuard(roles, input, { agent: "mimir-test" }, root),
  ).rejects.toThrow("task");
  await enforceRoleGuard(roles, input, { agent: "general" }, root);
  const utility = { output: "Explored the tree.", metadata: {} };
  expect(
    await gateTaskOutput(
      {
        tool: "subagent",
        callID: "u",
        sessionID: "parent",
        args: { agent: "general" },
      },
      utility,
      root,
    ),
  ).toBe("skip");
  expect(utility.output).toBe("Explored the tree.");
});

test("actual before-hook guard fails closed on malformed task state for edit and shell", async () => {
  const root = dirs[dirs.length - 1] ?? "";
  await Bun.write(
    coordinatorStatePath("parent"),
    JSON.stringify({ active: true, planFile: "/plan", task: { base: 123 } }),
  );
  const roles = createSessionRoles(async () => ({}));
  for (const tool of ["edit", "shell"]) {
    await expect(
      enforceRoleGuard(
        roles,
        { tool, sessionID: "parent" },
        { filePath: "a.ts", command: "touch a.ts" },
        root,
      ),
    ).rejects.toThrow("Invalid coordinator task state");
  }
});

for (const committedPlan of [false, true]) {
  test(`cold review excludes the active ${committedPlan ? "committed" : "untracked"} plan but retains task changes`, async () => {
    const root = join(dirs[dirs.length - 1] ?? "", "repo");
    await mkdir(root);
    const git = async (...args: string[]) => {
      const result = await runCommand(["git", ...args], root);
      expect(result.code).toBe(0);
      return result.stdout.trim();
    };
    await git("init", "-q");
    await git("config", "user.name", "fixture");
    await git("config", "user.email", "fixture@example.invalid");
    await Bun.write(join(root, "value.ts"), "export const value = 0;\n");
    await Bun.write(join(root, "value.test.ts"), "test('zero', () => {});\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const planFile = join(root, ".mimir/plans/value.md");
    await writeCoordinatorState("parent", {
      active: true,
      planFile,
      task: { base: await git("rev-parse", "HEAD"), worktree: root },
    });
    await Bun.write(planFile, "PRIVATE_DELEGATION_RATIONALE\n");
    await Bun.write(join(root, "value.test.ts"), "test('one', () => {});\n");
    await git("add", "value.test.ts");
    if (committedPlan) await git("add", ".mimir/plans/value.md");
    await git("commit", "-qm", "red test");
    await Bun.write(join(root, "value.ts"), "export const value = 1;\n");
    await Bun.write(join(root, "docs/value.md"), "REVIEWABLE_DOCUMENTATION\n");
    const context: ToolContext = {
      ...JSON.parse(
        '{"sessionID":"review-child","messageID":"m","agent":"mimir-review","id":"c"}',
      ),
      signal: new AbortController().signal,
      progress: async () => {},
    };
    const result = await reviewPromptTool(
      join(root, "nested"),
      async () => "parent",
      root,
    ).execute({ title: "Value" }, context);
    expect(result.content).toContain("=== value.test.ts");
    expect(result.content).toContain("test('one'");
    expect(result.content).toContain("=== value.ts");
    expect(result.content).toContain("export const value = 1");
    expect(result.content).toContain("REVIEWABLE_DOCUMENTATION");
    expect(result.content).not.toContain(".mimir/plans/value.md");
    expect(result.content).not.toContain("PRIVATE_DELEGATION_RATIONALE");
  });
}

test("an active plan alone is not a reviewable change", async () => {
  const root = join(dirs[dirs.length - 1] ?? "", "repo");
  await mkdir(root);
  const git = async (...args: string[]) => {
    const result = await runCommand(["git", ...args], root);
    expect(result.code).toBe(0);
    return result.stdout.trim();
  };
  await git("init", "-q");
  await git("config", "user.name", "fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("commit", "--allow-empty", "-qm", "base");
  const planFile = join(root, "plan.md");
  await writeCoordinatorState("parent", {
    active: true,
    planFile,
    task: { base: await git("rev-parse", "HEAD"), worktree: root },
  });
  await Bun.write(planFile, "PRIVATE_DELEGATION_RATIONALE\n");
  const context: ToolContext = {
    ...JSON.parse(
      '{"sessionID":"parent","messageID":"m","agent":"mimir","id":"c"}',
    ),
    signal: new AbortController().signal,
    progress: async () => {},
  };
  expect(
    (await reviewPromptTool(root).execute({ title: "Value" }, context)).content,
  ).toContain("nothing to review");
});
