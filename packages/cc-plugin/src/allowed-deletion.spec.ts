/**
 * The coordinator's allowed test-file deletions reach the verify gate:
 * `mimir-cc delegate allow-deletion` records them for the current task,
 * and both a worker's hand-back and a manual `mimir-cc verify` honour
 * them. Real git repository, real processes — the fixture is the one
 * task-base.spec.ts uses.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dir);
const session = "cc-allowed-deletion";
const WORKER = "impl-worker";
// Each test launches git and bun processes, and the gate runs the
// fixture's own suite; the runner's 5 s default is too short.
const RUN_TIMEOUT_MS = 60_000;
// Neither path is a substring of the other.
const FIRST = "first.spec.ts";
const SECOND = "second.spec.ts";
const HEADER =
  'import { expect, test } from "bun:test";\nimport { value } from "./value";\n';
const DENY = '"permissionDecision":"deny"';
const ALLOWED_TWO = "Allowed test deletions (2)";

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

const delegate = (...args: string[]) =>
  command("delegate-command.ts", "runDelegateCommand", args);

/** A worker's hand-back, sent from the session's directory. */
const handback = () =>
  command("verify-hook.ts", "runVerifyHook", [], {
    session_id: session,
    cwd: repo,
    agent_id: WORKER,
    agent_type: "mimir-impl",
    hook_event_name: "PreToolUse",
    tool_name: "SubagentHandback",
    tool_input: { message: "STATUS: done" },
  });

const deletedLine = (path: string) => `${path}: test file deleted`;
const valueTest = (name: string) =>
  `test(${JSON.stringify(name)}, () => expect(value).toBe(0));\n`;

beforeEach(async () => {
  previousHome = process.env.MIMIR_HOME;
  dir = mkdtempSync(join(tmpdir(), "mimir-cc-allowed-"));
  repo = join(dir, "repo");
  process.env.MIMIR_HOME = join(dir, "home");
  await git(dir, "init", "-b", "main", repo);
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await git(repo, "config", "user.name", "Fixture");
  await Bun.write(join(repo, "value.ts"), "export const value = 0;\n");
  await Bun.write(join(repo, "value.spec.ts"), HEADER + valueTest("value"));
  await Bun.write(join(repo, FIRST), HEADER + valueTest("first"));
  await Bun.write(join(repo, SECOND), HEADER + valueTest("second"));
  await Bun.write(
    join(repo, "package.json"),
    JSON.stringify({ scripts: { test: "bun test" } }),
  );
  // The toolchain resolver picks the package manager from the lockfile.
  await Bun.write(join(repo, "bun.lock"), "{}\n");
  await Bun.write(join(repo, ".gitignore"), ".claude/worktrees/\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "baseline");
  await Bun.write(join(repo, "plan.md"), "plan\n");
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
 * The task begins; its worker folds first.spec.ts and second.spec.ts into
 * value.spec.ts and deletes both, uncommitted in its own worktree (where
 * Claude Code puts it). Returns the worker's worktree.
 */
const foldedInWorker = async () => {
  expect((await delegate("task")).code).toBe(0);
  const worker = join(repo, ".claude", "worktrees", `agent-${WORKER}`);
  await git(repo, "worktree", "add", "-b", `worktree-agent-${WORKER}`, worker);
  const folded = join(worker, "value.spec.ts");
  await Bun.write(
    folded,
    (await Bun.file(folded).text()) + valueTest("first") + valueTest("second"),
  );
  rmSync(join(worker, FIRST));
  rmSync(join(worker, SECOND));
  return worker;
};

test(
  "the hand-back honours the task's allowed deletions, blocks the rest, and the next task allows nothing",
  async () => {
    await foldedInWorker();

    expect((await delegate("allow-deletion", FIRST)).code).toBe(0);
    const partial = await handback();
    expect(partial.stdout).toContain(DENY);
    expect(partial.stdout).toContain(deletedLine(SECOND));
    expect(partial.stdout).not.toContain(deletedLine(FIRST));

    expect((await delegate("allow-deletion", SECOND)).code).toBe(0);
    const allowed = await handback();
    expect(allowed.code, allowed.stderr).toBe(0);
    expect(allowed.stdout).toContain("Verify gate passed");
    expect(allowed.stdout).toContain(ALLOWED_TWO);
    expect(allowed.stdout).toContain(FIRST);
    expect(allowed.stdout).toContain(SECOND);

    expect((await delegate("task")).code).toBe(0);
    const next = await handback();
    expect(next.stdout).toContain(DENY);
    expect(next.stdout).toContain(deletedLine(FIRST));
    expect(next.stdout).toContain(deletedLine(SECOND));
  },
  RUN_TIMEOUT_MS,
);

test(
  "manual verify honours the task's allowed deletions, blocks the rest, and after stop allows nothing",
  async () => {
    const worker = await foldedInWorker();
    const verify = () =>
      command("verify-hook.ts", "runVerifyHook", ["--worktree", worker]);

    expect((await delegate("allow-deletion", FIRST)).code).toBe(0);
    const partial = await verify();
    expect(partial.code).toBe(1);
    expect(partial.stdout).toContain(deletedLine(SECOND));
    expect(partial.stdout).not.toContain(deletedLine(FIRST));

    expect((await delegate("allow-deletion", SECOND)).code).toBe(0);
    const allowed = await verify();
    expect(allowed.code, allowed.stdout + allowed.stderr).toBe(0);
    expect(allowed.stdout).toContain(ALLOWED_TWO);
    expect(allowed.stdout).toContain(FIRST);
    expect(allowed.stdout).toContain(SECOND);

    expect((await delegate("stop")).code).toBe(0);
    const stopped = await verify();
    expect(stopped.code).toBe(1);
    expect(stopped.stdout).toContain(deletedLine(FIRST));
    expect(stopped.stdout).toContain(deletedLine(SECOND));
  },
  RUN_TIMEOUT_MS,
);
