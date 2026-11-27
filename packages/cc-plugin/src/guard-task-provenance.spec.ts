/**
 * The role guard and task provenance, end to end: `runGuardHook` in its own
 * process with the payload on stdin, against a real git repository.
 *
 * These three were part of task-base.spec.ts. They still run git because
 * guard-hook.ts spawns it directly; taking git out of the guard's specs is
 * separate work.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  coordinatorStatePath,
  writeCoordinatorState,
} from "@mimir/plugin-core/guard";

const source = resolve(import.meta.dir);
const session = "cc-guard-provenance";
const WORKER = "impl-worker";
// Every test here launches several git and bun processes; the runner's 5 s
// default is sized for in-process tests.
const RUN_TIMEOUT_MS = 60_000;
const DENY = '"permissionDecision":"deny"';
let dir: string;
let repo: string;
let previousHome: string | undefined;

const git = async (cwd: string, ...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited, stderr).toBe(0);
};

const command = async (
  module: string,
  fn: string,
  args: string[],
  input?: unknown,
) => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    MIMIR_ACTIVE: "1",
    CLAUDE_CODE_SESSION_ID: session,
  };
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { ${fn} } from ${JSON.stringify(join(source, module))}; process.exit(await ${fn}(${JSON.stringify(args)}));`,
    ],
    {
      cwd: repo,
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

const guard = (extra: object) =>
  command("guard-hook.ts", "runGuardHook", [], {
    session_id: session,
    cwd: repo,
    agent_id: WORKER,
    agent_type: "mimir-impl",
    hook_event_name: "PreToolUse",
    ...extra,
  });

/** The coordinator spawning an agent of the given type. */
const spawn = (subagent_type: string) =>
  guard({
    agent_type: undefined,
    tool_name: "Agent",
    tool_input: { subagent_type, prompt: "go" },
  });

beforeEach(async () => {
  previousHome = process.env.MIMIR_HOME;
  dir = mkdtempSync(join(tmpdir(), "mimir-cc-guard-task-"));
  repo = join(dir, "repo");
  process.env.MIMIR_HOME = join(dir, "home");
  await git(dir, "init", "-b", "main", repo);
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await git(repo, "config", "user.name", "Fixture");
  await Bun.write(join(repo, "value.ts"), "export const value = 0;\n");
  // As in a real project: agent worktrees are not part of the session's diff.
  await Bun.write(join(repo, ".gitignore"), ".claude/worktrees/\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "baseline");
  await Bun.write(join(repo, "plan.md"), "plan\n");
  const started = await command("delegate-command.ts", "runDelegateCommand", [
    "start",
    "--plan",
    join(repo, "plan.md"),
  ]);
  expect(started.code, started.stderr).toBe(0);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = previousHome;
  rmSync(dir, { recursive: true, force: true });
});

test(
  "an active delegation refuses to spawn a worker with missing or malformed task provenance",
  async () => {
    expect((await spawn("mimir-cc:mimir-impl")).stdout).toContain(DENY);
    await writeCoordinatorState(session, {
      active: true,
      planFile: join(repo, "plan.md"),
      task: { base: "broken", worktree: repo },
    });
    expect((await spawn("mimir-cc:mimir-impl")).stdout).toContain(DENY);
  },
  RUN_TIMEOUT_MS,
);

test(
  "utility agents spawn without a task boundary; only Mimir's workers are gated",
  async () => {
    expect((await spawn("Explore")).stdout).toBe("");
    const worker = await spawn("mimir-cc:mimir-test");
    expect(worker.stdout).toContain(DENY);
    expect(worker.stdout).toContain("task provenance");
    // A worker's ordinary tool call is not re-proven: spawn and hand-back are
    // the gates. (This worker's first call also bootstraps its "worktree".)
    const read = await guard({
      tool_name: "Read",
      tool_input: { file_path: join(repo, "value.ts") },
    });
    expect(read.stdout).toBe("");
  },
  RUN_TIMEOUT_MS,
);

test(
  "malformed task state fails closed for the coordinator's own edit",
  async () => {
    await Bun.write(
      coordinatorStatePath(session),
      JSON.stringify({
        active: true,
        planFile: join(repo, "plan.md"),
        task: { base: 123 },
      }),
    );
    const edit = await guard({
      agent_type: undefined,
      tool_name: "Edit",
      tool_input: { file_path: join(repo, "value.ts"), old_string: "0" },
    });
    expect(edit.stdout).toContain(DENY);
    expect(edit.stdout).toContain("delegate stop");
  },
  RUN_TIMEOUT_MS,
);
