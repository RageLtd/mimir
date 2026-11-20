import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  coordinatorStatePath,
  readCoordinatorState,
  writeCoordinatorState,
} from "@mimir/plugin-core/guard";

const source = resolve(import.meta.dir);
const session = "cc-task-regression";
const WORKER = "impl-worker";
// Every test here launches a dozen or more git and bun processes, and the
// verify gate runs the fixture's own suite inside one of them. The runner's
// 5 s default is sized for in-process tests and is overrun under a full
// parallel run.
const RUN_TIMEOUT_MS = 60_000;
let dir: string;
let repo: string;
let previousHome: string | undefined;

const git = async (cwd: string, ...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited, stderr).toBe(0);
  return stdout.trim();
};

const command = async (
  module: string,
  fn: string,
  args: string[],
  cwd = repo,
  input?: unknown,
  withSession = true,
) => {
  // The suite itself may run inside a Claude Code session, whose Bash
  // already carries the variable — strip it rather than merely not set it.
  const env: Record<string, string | undefined> = {
    ...process.env,
    MIMIR_ACTIVE: "1",
  };
  if (withSession) env.CLAUDE_CODE_SESSION_ID = session;
  else delete env.CLAUDE_CODE_SESSION_ID;
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { ${fn} } from ${JSON.stringify(join(source, module))}; process.exit(await ${fn}(${JSON.stringify(args)}));`,
    ],
    {
      cwd,
      env,
      stdin: input === undefined ? "ignore" : new Blob([JSON.stringify(input)]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout, stderr };
};
const delegate = (...args: string[]) =>
  command("delegate-command.ts", "runDelegateCommand", args);
const hook = (module: string, fn: string, cwd: string, extra: object) =>
  command(module, fn, [], cwd, {
    session_id: session,
    cwd,
    agent_id: WORKER,
    agent_type: "mimir-impl",
    hook_event_name: "PreToolUse",
    tool_name: "SubagentHandback",
    tool_input: { message: "STATUS: done" },
    ...extra,
  });
const branchOf = (agent: string) => `worktree-agent-${agent}`;
/**
 * A Mimir worker's tree, where Claude Code puts it: a git worktree at
 * `<root>/.claude/worktrees/agent-<agent id>`, branched from root's HEAD.
 * A worker's hand-back is gated there and nowhere else.
 */
const addWorker = async (agent = WORKER, root = repo) => {
  const path = join(root, ".claude", "worktrees", `agent-${agent}`);
  await git(root, "worktree", "add", "-b", branchOf(agent), path);
  return path;
};
beforeEach(async () => {
  previousHome = process.env.MIMIR_HOME;
  dir = mkdtempSync(join(tmpdir(), "mimir-cc-task-"));
  repo = join(dir, "repo");
  process.env.MIMIR_HOME = join(dir, "home");
  await git(dir, "init", "-b", "main", repo);
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await git(repo, "config", "user.name", "Fixture");
  await Bun.write(join(repo, "value.ts"), "export const value = 0;\n");
  await Bun.write(
    join(repo, "value.spec.ts"),
    'import { expect, test } from "bun:test";\nimport { value } from "./value";\ntest("value", () => expect(value).toBe(0));\n',
  );
  await Bun.write(
    join(repo, "package.json"),
    JSON.stringify({ scripts: { test: "bun test" } }),
  );
  // The toolchain resolver picks the package manager from the lockfile;
  // without one it runs `npm run`, which a Bun-only machine lacks.
  await Bun.write(join(repo, "bun.lock"), "{}\n");
  // As in a real project: agent worktrees are not part of the session's diff.
  await Bun.write(join(repo, ".gitignore"), ".claude/worktrees/\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "baseline");
  await Bun.write(join(repo, "plan.md"), "private plan rationale\n");
  expect((await delegate("start", "--plan", join(repo, "plan.md"))).code).toBe(
    0,
  );
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A task whose red test has been collected by merge from its own worktree,
 * with a worker's green change waiting uncommitted in the worker's worktree
 * and the delegation restarted since. Returns the task's base and the
 * worker's worktree.
 */
const redCollectedGreenPending = async () => {
  const base = await git(repo, "rev-parse", "HEAD");
  expect((await delegate("task")).code).toBe(0);
  const red = join(dir, "red");
  await git(repo, "worktree", "add", "-b", "red", red);
  await Bun.write(
    join(red, "value.spec.ts"),
    (await Bun.file(join(red, "value.spec.ts")).text()).replace(
      "toBe(0)",
      "toBe(1)",
    ),
  );
  await git(red, "add", "value.spec.ts");
  await git(red, "commit", "-m", "red regression");
  await git(repo, "merge", "--no-ff", "red", "-m", "collect red");
  const worker = await addWorker();
  await Bun.write(join(worker, "value.ts"), "export const value = 1;\n");
  await Bun.write(join(worker, "plan.md"), "private plan rationale\n");
  await delegate("start", "--plan", join(repo, "plan.md"));
  return { base, worker };
};

test(
  "the task base survives a red commit, a separate impl worktree and a restart",
  async () => {
    const { base } = await redCollectedGreenPending();
    expect((await readCoordinatorState(session))?.task?.base).toBe(base);
  },
  RUN_TIMEOUT_MS,
);

test(
  "the hand-back is verified in the worker's worktree against the surviving base",
  async () => {
    await redCollectedGreenPending();
    // Sent from the session's directory; gated in the worker's worktree.
    const result = await hook("verify-hook.ts", "runVerifyHook", repo, {});
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Verify gate passed");
    expect(result.stdout).toContain("1 → 1");
  },
  RUN_TIMEOUT_MS,
);

test(
  "the cold review shows the task's test and change and leaves the plan out",
  async () => {
    const { worker } = await redCollectedGreenPending();
    const review = await command(
      "delegate-command.ts",
      "runReviewPromptCommand",
      [worker],
    );
    expect(review.code, review.stderr).toBe(0);
    expect(review.stdout).toContain("value.spec.ts");
    expect(review.stdout).toContain("value.ts");
    expect(review.stdout).not.toContain("private plan rationale");
  },
  RUN_TIMEOUT_MS,
);

test(
  "the next task starts from the collected work, where a change with no test fails for coverage",
  async () => {
    const { worker } = await redCollectedGreenPending();
    await git(worker, "add", "value.ts");
    await git(worker, "commit", "-m", "green");
    await git(repo, "merge", "--no-ff", branchOf(WORKER), "-m", "collect impl");
    expect((await delegate("task")).code).toBe(0);
    expect((await readCoordinatorState(session))?.task?.base).toBe(
      await git(repo, "rev-parse", "HEAD"),
    );
    const nextAgent = "next-worker";
    const nextWorker = await addWorker(nextAgent);
    await Bun.write(join(nextWorker, "value.ts"), "export const value = 2;\n");
    const next = await hook("verify-hook.ts", "runVerifyHook", repo, {
      agent_id: nextAgent,
    });
    expect(next.stdout).toContain("No test coverage");
  },
  RUN_TIMEOUT_MS,
);

test(
  "active delegation refuses missing or malformed task provenance at spawn and handback",
  async () => {
    await addWorker();
    const spawn = () =>
      hook("guard-hook.ts", "runGuardHook", repo, {
        agent_type: undefined,
        tool_name: "Agent",
        tool_input: { subagent_type: "mimir-cc:mimir-impl", prompt: "green" },
      });
    expect((await spawn()).stdout).toContain('"permissionDecision":"deny"');
    expect(
      (await hook("verify-hook.ts", "runVerifyHook", repo, {})).stdout,
    ).toContain('"permissionDecision":"deny"');
    await writeCoordinatorState(session, {
      active: true,
      planFile: join(repo, "plan.md"),
      task: { base: "broken", worktree: repo },
    });
    expect((await spawn()).stdout).toContain('"permissionDecision":"deny"');
    expect(
      (await hook("verify-hook.ts", "runVerifyHook", repo, {})).stdout,
    ).toContain('"permissionDecision":"deny"');
  },
  RUN_TIMEOUT_MS,
);

test(
  "utility agents spawn without a task boundary; only Mimir's workers are gated",
  async () => {
    const spawn = (subagent_type: string) =>
      hook("guard-hook.ts", "runGuardHook", repo, {
        agent_type: undefined,
        tool_name: "Agent",
        tool_input: { subagent_type, prompt: "go" },
      });
    expect((await spawn("Explore")).stdout).toBe("");
    const worker = await spawn("mimir-cc:mimir-test");
    expect(worker.stdout).toContain('"permissionDecision":"deny"');
    expect(worker.stdout).toContain("task provenance");
    // A worker's ordinary tool call is not re-proven: spawn and hand-back are
    // the gates. (This worker's first call also bootstraps its "worktree".)
    const read = await hook("guard-hook.ts", "runGuardHook", repo, {
      tool_name: "Read",
      tool_input: { file_path: join(repo, "value.ts") },
    });
    expect(read.stdout).toBe("");
  },
  RUN_TIMEOUT_MS,
);

test(
  "malformed task state fails closed for the coordinator and is reported, not thrown",
  async () => {
    await Bun.write(
      coordinatorStatePath(session),
      JSON.stringify({
        active: true,
        planFile: join(repo, "plan.md"),
        task: { base: 123 },
      }),
    );
    const edit = await hook("guard-hook.ts", "runGuardHook", repo, {
      agent_type: undefined,
      tool_name: "Edit",
      tool_input: { file_path: join(repo, "value.ts"), old_string: "0" },
    });
    expect(edit.stdout).toContain('"permissionDecision":"deny"');
    expect(edit.stdout).toContain("delegate stop");
    const status = await delegate("status");
    expect(status.code).toBe(1);
    expect(status.stderr).toContain("Invalid coordinator task state");
    expect(status.stderr).not.toContain("    at ");
    expect((await delegate("stop")).code).toBe(0);
    expect((await delegate("status")).stdout).toContain("no active delegation");
  },
  RUN_TIMEOUT_MS,
);

test(
  "review-prompt refuses to run without the session instead of reviewing a merge-base diff",
  async () => {
    await Bun.write(join(repo, "value.ts"), "export const value = 1;\n");
    const review = await command(
      "delegate-command.ts",
      "runReviewPromptCommand",
      [repo],
      repo,
      undefined,
      false,
    );
    expect(review.code).toBe(1);
    expect(review.stderr).toContain("CLAUDE_CODE_SESSION_ID");
    expect(review.stdout).not.toContain("value.ts");
  },
  RUN_TIMEOUT_MS,
);

test(
  "manual verify uses task base and rejects a different repository",
  async () => {
    await delegate("task");
    await Bun.write(
      join(repo, "value.spec.ts"),
      (await Bun.file(join(repo, "value.spec.ts")).text()).replace(
        "toBe(0)",
        "toBe(1)",
      ),
    );
    await git(repo, "add", "value.spec.ts");
    await git(repo, "commit", "-m", "red");
    await Bun.write(join(repo, "value.ts"), "export const value = 1;\n");
    const verify = await command("verify-hook.ts", "runVerifyHook", [
      "--worktree",
      repo,
    ]);
    expect(verify.code, verify.stdout + verify.stderr).toBe(0);
    const other = join(dir, "other");
    await git(dir, "clone", repo, other);
    // The worker's worktree belongs to the foreign repository.
    await addWorker(WORKER, other);
    const foreign = await hook("verify-hook.ts", "runVerifyHook", other, {});
    expect(foreign.stdout).toContain('"permissionDecision":"deny"');
    expect(foreign.stdout).toContain("repository");
  },
  RUN_TIMEOUT_MS,
);

test(
  "failed next boundary clears previous task before capture",
  async () => {
    await delegate("task");
    expect((await readCoordinatorState(session))?.task).toBeDefined();
    const result = await command(
      "delegate-command.ts",
      "runDelegateCommand",
      ["task"],
      dir,
    );
    expect(result.code).not.toBe(0);
    expect((await readCoordinatorState(session))?.task).toBeUndefined();
  },
  RUN_TIMEOUT_MS,
);

test(
  "corrupt state and non-ancestor task bases cannot bypass handback or review",
  async () => {
    // Branched before the integration advances below: its HEAD stays behind.
    const worker = await addWorker();
    await Bun.write(coordinatorStatePath(session), '{"active":true,');
    const corrupt = await hook("verify-hook.ts", "runVerifyHook", repo, {});
    expect(corrupt.stdout).toContain('"permissionDecision":"deny"');
    await delegate("stop");
    await delegate("start", "--plan", join(repo, "plan.md"));
    await Bun.write(join(repo, "later.md"), "next task baseline\n");
    await git(repo, "add", "later.md");
    await git(repo, "commit", "-m", "advance integration");
    await delegate("task");
    const denied = await hook("verify-hook.ts", "runVerifyHook", repo, {});
    expect(denied.stdout).toContain('"permissionDecision":"deny"');
    const review = await command(
      "delegate-command.ts",
      "runReviewPromptCommand",
      [worker],
    );
    expect(review.code).not.toBe(0);
    expect(review.stderr).toContain("Cannot validate task repository");
  },
  RUN_TIMEOUT_MS,
);

test(
  "task takes no base arguments and changing plans discards the old boundary",
  async () => {
    await delegate("task");
    const original = (await readCoordinatorState(session))?.task;
    expect((await delegate("task", "--base", "HEAD")).code).toBe(1);
    expect((await readCoordinatorState(session))?.task).toEqual(original);
    const nextPlan = join(repo, "next-plan.md");
    await Bun.write(nextPlan, "next plan\n");
    expect((await delegate("start", "--plan", nextPlan)).code).toBe(0);
    expect((await readCoordinatorState(session))?.task).toBeUndefined();
  },
  RUN_TIMEOUT_MS,
);

test(
  "active task verification and review collect from Git root when invoked in a nested directory",
  async () => {
    await delegate("task");
    await Bun.write(
      join(repo, "value.spec.ts"),
      (await Bun.file(join(repo, "value.spec.ts")).text()).replace(
        "toBe(0)",
        "toBe(1)",
      ),
    );
    await git(repo, "add", "value.spec.ts");
    await git(repo, "commit", "-m", "red");
    // The red test is collected; the green change is the worker's, in its
    // worktree. Review and manual verify name a directory nested in that
    // worktree; the hand-back comes from one nested in the session's.
    const worker = await addWorker();
    await Bun.write(join(worker, "value.ts"), "export const value = 1;\n");
    const nested = join(worker, "nested", "directory");
    mkdirSync(nested, { recursive: true });
    const sessionNested = join(repo, "nested", "directory");
    mkdirSync(sessionNested, { recursive: true });
    const review = await command(
      "delegate-command.ts",
      "runReviewPromptCommand",
      [nested],
      nested,
    );
    expect(review.code, review.stderr).toBe(0);
    expect(review.stdout).toContain("value.spec.ts");
    expect(review.stdout).toContain("export const value = 1;");
    const verify = await command(
      "verify-hook.ts",
      "runVerifyHook",
      ["--worktree", nested],
      nested,
    );
    expect(verify.code, verify.stdout + verify.stderr).toBe(0);
    expect(verify.stdout).toContain("Verify gate passed");
    const handback = await hook(
      "verify-hook.ts",
      "runVerifyHook",
      sessionNested,
      {},
    );
    expect(handback.stdout).toContain("Verify gate passed");
  },
  RUN_TIMEOUT_MS,
);

test(
  "starting an equivalent plan alias preserves the task while a missing plan still starts with a warning",
  async () => {
    await delegate("task");
    const original = await readCoordinatorState(session);
    const alias = join(dir, "repo-alias");
    symlinkSync(repo, alias, "dir");
    expect(
      (await delegate("start", "--plan", join(alias, "plan.md"))).code,
    ).toBe(0);
    expect(await readCoordinatorState(session)).toEqual(original);
    const missingPlan = join(repo, "missing-plan.md");
    const missing = await delegate("start", "--plan", missingPlan);
    expect(missing.code, missing.stderr).toBe(0);
    expect(missing.stdout).toContain("plan file not written yet");
    expect((await readCoordinatorState(session))?.task).toBeUndefined();
  },
  RUN_TIMEOUT_MS,
);
