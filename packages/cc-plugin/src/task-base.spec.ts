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
    agent_id: "impl-worker",
    agent_type: "mimir-impl",
    hook_event_name: "PreToolUse",
    tool_name: "SubagentHandback",
    tool_input: { message: "STATUS: done" },
    ...extra,
  });

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

test("explicit boundary survives red commit, separate impl worktree, restart and cold review", async () => {
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
  const worker = join(dir, "impl");
  await git(repo, "worktree", "add", "-b", "impl", worker);
  await Bun.write(join(worker, "value.ts"), "export const value = 1;\n");
  await Bun.write(join(worker, "plan.md"), "private plan rationale\n");
  await delegate("start", "--plan", join(repo, "plan.md"));
  expect((await readCoordinatorState(session))?.task?.base).toBe(base);
  const result = await hook("verify-hook.ts", "runVerifyHook", worker, {});
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Verify gate passed");
  expect(result.stdout).toContain("1 → 1");
  const review = await command(
    "delegate-command.ts",
    "runReviewPromptCommand",
    [worker],
  );
  expect(review.code, review.stderr).toBe(0);
  expect(review.stdout).toContain("value.spec.ts");
  expect(review.stdout).toContain("value.ts");
  expect(review.stdout).not.toContain("private plan rationale");
  await git(worker, "add", "value.ts");
  await git(worker, "commit", "-m", "green");
  await git(repo, "merge", "--no-ff", "impl", "-m", "collect impl");
  expect((await delegate("task")).code).toBe(0);
  expect((await readCoordinatorState(session))?.task?.base).toBe(
    await git(repo, "rev-parse", "HEAD"),
  );
  await Bun.write(join(repo, "value.ts"), "export const value = 2;\n");
  const next = await hook("verify-hook.ts", "runVerifyHook", repo, {
    agent_id: "next-worker",
  });
  expect(next.stdout).toContain("No test coverage");
});

test("active delegation refuses missing or malformed task provenance at spawn and handback", async () => {
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
});

test("utility agents spawn without a task boundary; only Mimir's workers are gated", async () => {
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
});

test("malformed task state fails closed for the coordinator and is reported, not thrown", async () => {
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
});

test("review-prompt refuses to run without the session instead of reviewing a merge-base diff", async () => {
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
});

test("manual verify uses task base and rejects a different repository", async () => {
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
  const foreign = await hook("verify-hook.ts", "runVerifyHook", other, {});
  expect(foreign.stdout).toContain('"permissionDecision":"deny"');
  expect(foreign.stdout).toContain("repository");
});

test("failed next boundary clears previous task before capture", async () => {
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
});

test("corrupt state and non-ancestor task bases cannot bypass handback or review", async () => {
  await Bun.write(coordinatorStatePath(session), '{"active":true,');
  const corrupt = await hook("verify-hook.ts", "runVerifyHook", repo, {});
  expect(corrupt.stdout).toContain('"permissionDecision":"deny"');
  await delegate("stop");
  await delegate("start", "--plan", join(repo, "plan.md"));
  const worker = join(dir, "old-worker");
  await git(repo, "worktree", "add", "-b", "old-worker", worker);
  await Bun.write(join(repo, "later.md"), "next task baseline\n");
  await git(repo, "add", "later.md");
  await git(repo, "commit", "-m", "advance integration");
  await delegate("task");
  const denied = await hook("verify-hook.ts", "runVerifyHook", worker, {});
  expect(denied.stdout).toContain('"permissionDecision":"deny"');
  const review = await command(
    "delegate-command.ts",
    "runReviewPromptCommand",
    [worker],
  );
  expect(review.code).not.toBe(0);
  expect(review.stderr).toContain("Cannot validate task repository");
});

test("task takes no base arguments and changing plans discards the old boundary", async () => {
  await delegate("task");
  const original = (await readCoordinatorState(session))?.task;
  expect((await delegate("task", "--base", "HEAD")).code).toBe(1);
  expect((await readCoordinatorState(session))?.task).toEqual(original);
  const nextPlan = join(repo, "next-plan.md");
  await Bun.write(nextPlan, "next plan\n");
  expect((await delegate("start", "--plan", nextPlan)).code).toBe(0);
  expect((await readCoordinatorState(session))?.task).toBeUndefined();
});

test("active task verification and review collect from Git root when invoked in a nested directory", async () => {
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
  const nested = join(repo, "nested", "directory");
  mkdirSync(nested, { recursive: true });
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
  const handback = await hook("verify-hook.ts", "runVerifyHook", nested, {});
  expect(handback.stdout).toContain("Verify gate passed");
});

test("starting an equivalent plan alias preserves the task while a missing plan still starts with a warning", async () => {
  await delegate("task");
  const original = await readCoordinatorState(session);
  const alias = join(dir, "repo-alias");
  symlinkSync(repo, alias, "dir");
  expect((await delegate("start", "--plan", join(alias, "plan.md"))).code).toBe(
    0,
  );
  expect(await readCoordinatorState(session)).toEqual(original);
  const missingPlan = join(repo, "missing-plan.md");
  const missing = await delegate("start", "--plan", missingPlan);
  expect(missing.code, missing.stderr).toBe(0);
  expect(missing.stdout).toContain("plan file not written yet");
  expect((await readCoordinatorState(session))?.task).toBeUndefined();
});
