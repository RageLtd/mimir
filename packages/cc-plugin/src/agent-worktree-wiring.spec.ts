/**
 * `mimir-cc rules`, `guard` and `verify` work in a subagent's worktree.
 *
 * The hooks module no longer learns a subagent's directory from
 * SubagentStart, so every payload carries the session's `cwd`; the binary
 * finds `.claude/worktrees/agent-<agent_id>` itself. Driven end to end —
 * `bun src/cli.ts <command>` with the payload on stdin — in a real git
 * repository with a real `git worktree`, so each test can see which
 * directory the command actually worked in.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cli.ts");
const AGENT = "a0123456789abcdef";
const SESSION = "cc-agent-worktree-wiring";
const DENY = '"permissionDecision":"deny"';
/** Carries an agent_id like any subagent, but runs in the session's tree. */
const NOT_A_WORKER = "Explore";
const GATE_PASSED = "Verify gate passed";
/** The gate runs the fixture's toolchain; give it room. */
const GATE_TIMEOUT_MS = 60_000;

let dir: string;
let repo: string;
let home: string;
let worktree: string;

const git = async (cwd: string, ...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited, stderr).toBe(0);
};

const addWorktree = () =>
  git(repo, "worktree", "add", "-q", "-b", `worktree-agent-${AGENT}`, worktree);

const cli = async (args: readonly string[], payload?: unknown) => {
  // The suite may itself run inside a Claude Code session; its session id
  // would point the gate at that session's delegation state.
  const env: Record<string, string | undefined> = {
    ...process.env,
    MIMIR_ACTIVE: "1",
    MIMIR_HOME: home,
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: dir,
    env,
    stdin:
      payload === undefined ? "ignore" : new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

const warnings = async () => {
  const log = Bun.file(join(home, "logs", "mimir-cc.log"));
  if (!(await log.exists())) return [];
  return (await log.text())
    .split("\n")
    .filter((line) => line.includes("[WARN]"));
};

const worktreeWarnings = async () =>
  (await warnings()).filter((line) =>
    line.includes(join(".claude", "worktrees")),
  );

const ruleToml = (id: string, marker: string) =>
  [
    `id = "${id}"`,
    "enabled = true",
    'event = "bash"',
    `message = "${id} fired"`,
    "",
    "[[conditions]]",
    'field = "command"',
    'operator = "regex_match"',
    `pattern = '${marker}'`,
    "",
  ].join("\n");

const toolCall = (extra: object) => ({
  session_id: SESSION,
  hook_event_name: "PreToolUse",
  cwd: repo,
  agent_id: AGENT,
  agent_type: "mimir-test",
  ...extra,
});

const bash = (command: string, extra: object = {}) =>
  toolCall({ tool_name: "Bash", tool_input: { command }, ...extra });

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mimir-cc-agent-wt-")));
  repo = join(dir, "repo");
  home = join(dir, "home");
  worktree = join(repo, ".claude", "worktrees", `agent-${AGENT}`);
  await git(dir, "init", "-q", "-b", "main", repo);
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
  // The toolchain resolver picks the package manager from the lockfile.
  await Bun.write(join(repo, "bun.lock"), "{}\n");
  // As in a real project: agent worktrees are not part of the session's diff.
  await Bun.write(join(repo, ".gitignore"), ".claude/worktrees/\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "baseline");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("mimir-cc rules", () => {
  test("a subagent's call from the session's directory is judged by its worktree's rules", async () => {
    await addWorktree();
    await Bun.write(
      join(worktree, ".claude", "rules", "wt.enforce.toml"),
      ruleToml("fixture/worktree-only", "worktree-marker"),
    );
    const ran = await cli(["rules"], bash("echo worktree-marker"));
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain(DENY);
    expect(ran.stdout).toContain("fixture/worktree-only");
    expect(await worktreeWarnings()).toEqual([]);
  });

  // The engine reads rules from its project root, so the kept cwd is the
  // worktree itself; a cwd deeper inside is covered by the resolver's spec.
  test("a cwd that already is the worktree is kept", async () => {
    await addWorktree();
    await Bun.write(
      join(worktree, ".claude", "rules", "wt.enforce.toml"),
      ruleToml("fixture/worktree-only", "worktree-marker"),
    );
    const ran = await cli(
      ["rules"],
      bash("echo worktree-marker", { cwd: worktree }),
    );
    expect(ran.stdout).toContain(DENY);
    expect(await worktreeWarnings()).toEqual([]);
  });

  test("no worktree for the agent: the payload's cwd is used, with one warning naming the agent and the path", async () => {
    await Bun.write(
      join(repo, ".claude", "rules", "root.enforce.toml"),
      ruleToml("fixture/root-only", "root-marker"),
    );
    const ran = await cli(["rules"], bash("echo root-marker"));
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain(DENY);
    expect(ran.stdout).toContain("fixture/root-only");
    const warned = (await warnings()).filter((line) => line.includes(AGENT));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(worktree);
  });

  test("no agent_id: cwd is used and nothing is warned, though a worktree exists", async () => {
    await addWorktree();
    await Bun.write(
      join(worktree, ".claude", "rules", "wt.enforce.toml"),
      ruleToml("fixture/worktree-only", "worktree-marker"),
    );
    const ran = await cli(
      ["rules"],
      bash("echo worktree-marker", {
        agent_id: undefined,
        agent_type: undefined,
      }),
    );
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toBe("");
    expect(await worktreeWarnings()).toEqual([]);
  });

  test("a subagent that is not a Mimir worker uses the payload's cwd and warns nothing", async () => {
    await Bun.write(
      join(repo, ".claude", "rules", "root.enforce.toml"),
      ruleToml("fixture/root-only", "root-marker"),
    );
    const ran = await cli(
      ["rules"],
      bash("echo root-marker", { agent_type: NOT_A_WORKER }),
    );
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain(DENY);
    expect(ran.stdout).toContain("fixture/root-only");
    expect(await worktreeWarnings()).toEqual([]);
  });

  test("a Mimir worker reported with the plugin prefix and no worktree warns once", async () => {
    await Bun.write(
      join(repo, ".claude", "rules", "root.enforce.toml"),
      ruleToml("fixture/root-only", "root-marker"),
    );
    const ran = await cli(
      ["rules"],
      bash("echo root-marker", { agent_type: "mimir-cc:mimir-impl" }),
    );
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain(DENY);
    const warned = (await warnings()).filter((line) => line.includes(AGENT));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(worktree);
  });
});

describe("mimir-cc guard", () => {
  // Inside the session's tree but outside the agent's worktree: allowed
  // when the guard thinks the agent owns the whole tree, denied when it
  // knows the agent owns only its worktree.
  const removeSessionSource = () => `rm -rf ${join(repo, "src")}`;

  test("a subagent's call from the session's directory is guarded against its worktree", async () => {
    await addWorktree();
    const ran = await cli(["guard"], bash(removeSessionSource()));
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain(DENY);
    expect(ran.stdout).toContain(worktree);
  });

  test("a cwd that already is the worktree is kept", async () => {
    await addWorktree();
    const ran = await cli(
      ["guard"],
      bash(removeSessionSource(), { cwd: worktree }),
    );
    expect(ran.stdout).toContain(DENY);
    expect(ran.stdout).toContain(worktree);
    expect(await worktreeWarnings()).toEqual([]);
  });

  test("no agent_id: cwd is used and nothing is warned, though a worktree exists", async () => {
    await addWorktree();
    const ran = await cli(
      ["guard", "--role", "test"],
      bash(removeSessionSource(), {
        agent_id: undefined,
        agent_type: undefined,
      }),
    );
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toBe("");
    expect(await worktreeWarnings()).toEqual([]);
  });

  test("a subagent that is not a Mimir worker is guarded in the payload's cwd and warns nothing", async () => {
    const ran = await cli(
      ["guard"],
      bash(removeSessionSource(), { agent_type: NOT_A_WORKER }),
    );
    expect(ran.code, ran.stderr).toBe(0);
    // Guarded against the session's tree, which the target lies inside.
    expect(ran.stdout).toBe("");
    expect(await worktreeWarnings()).toEqual([]);
  });
});

describe("mimir-cc verify", () => {
  const handback = (extra: object = {}) =>
    toolCall({
      agent_type: "mimir-impl",
      tool_name: "SubagentHandback",
      tool_input: { message: "Made value 1.\n\nSTATUS: done" },
      ...extra,
    });

  test(
    "a hand-back from the session's directory verifies the worktree's change set",
    async () => {
      await addWorktree();
      await Bun.write(join(worktree, "value.ts"), "export const value = 1;\n");
      await Bun.write(
        join(worktree, "value.spec.ts"),
        'import { expect, test } from "bun:test";\nimport { value } from "./value";\ntest("value", () => expect(value).toBe(1));\n',
      );
      const ran = await cli(["verify"], handback());
      expect(ran.code, ran.stderr).toBe(0);
      expect(ran.stdout).not.toContain(DENY);
      expect(ran.stdout).toContain(GATE_PASSED);
      expect(ran.stdout).toContain("value.ts");
      expect(await worktreeWarnings()).toEqual([]);
    },
    GATE_TIMEOUT_MS,
  );

  // A source change with no test in the session's tree: the impl gate
  // denies it when run there, so silence proves it did not run there.
  const dirtySessionTree = () =>
    Bun.write(join(repo, "value.ts"), "export const value = 1;\n");

  test(
    "a Mimir worker's hand-back with no worktree does not gate the session's tree",
    async () => {
      await dirtySessionTree();
      const ran = await cli(["verify"], handback());
      expect(ran.code, ran.stderr).toBe(0);
      expect(ran.stdout).not.toContain(DENY);
      expect(ran.stdout).not.toContain(GATE_PASSED);
      expect(ran.stdout).toBe("");
      const warned = (await warnings()).filter((line) => line.includes(AGENT));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain(worktree);
    },
    GATE_TIMEOUT_MS,
  );

  test(
    "a hand-back from a subagent that is not a Mimir worker warns nothing about a worktree",
    async () => {
      await dirtySessionTree();
      const ran = await cli(["verify"], handback({ agent_type: NOT_A_WORKER }));
      expect(ran.code, ran.stderr).toBe(0);
      // As today: gated on the session's tree with the impl role.
      expect(ran.stdout).toContain(DENY);
      expect(ran.stdout).toContain("No test coverage");
      expect(ran.stdout).toContain("value.ts");
      expect(await worktreeWarnings()).toEqual([]);
    },
    GATE_TIMEOUT_MS,
  );
});

describe("usage text", () => {
  test("verify no longer offers SubagentStop, session-end no longer takes the whole window", async () => {
    const ran = await cli(["no-such-command"]);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("  verify ");
    expect(ran.stderr).toContain("  session-end ");
    expect(ran.stderr).not.toContain("SubagentStop");
    expect(ran.stderr).not.toContain("whole window");
  });
});
