import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cwdMissing,
  handbackOutput,
  parseVerifyArgs,
  roleOf,
} from "./verify-hook";

/**
 * The hook leg end to end — `bun src/cli.ts verify` with the payload on
 * stdin. The classic SubagentStop event no longer reaches the plugin, so
 * its payload shape is not a second way into the gate; the hand-back is.
 */
describe("mimir-cc verify as a hook", () => {
  const CLI = join(import.meta.dir, "cli.ts");
  const AGENT = "a0123456789abcdef";
  const DONE = "Made value 1.\n\nSTATUS: done";
  let dir: string;
  let repo: string;
  let home: string;

  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };

  const verify = async (payload: object) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      MIMIR_ACTIVE: "1",
      MIMIR_HOME: home,
    };
    delete env.CLAUDE_CODE_SESSION_ID;
    const proc = Bun.spawn([process.execPath, CLI, "verify"], {
      cwd: dir,
      env,
      stdin: new Blob([
        JSON.stringify({
          session_id: "cc-verify-hook-spec",
          cwd: repo,
          agent_id: AGENT,
          agent_type: "mimir-impl",
          ...payload,
        }),
      ]),
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

  const gateLogLines = async () => {
    const log = Bun.file(join(home, "logs", "mimir-cc.log"));
    if (!(await log.exists())) return [];
    return (
      (await log.text())
        .split("\n")
        // The one line the gate writes per run, with its outcome.
        .filter((line) => line.includes("verify-hook: verify gate {"))
    );
  };

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "mimir-cc-verify-hook-")));
    repo = join(dir, "repo");
    home = join(dir, "home");
    git(dir, "init", "-q", "-b", "main", repo);
    git(repo, "config", "user.email", "fixture@example.invalid");
    git(repo, "config", "user.name", "Fixture");
    git(repo, "commit", "-q", "--allow-empty", "-m", "baseline");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a SubagentStop payload claiming done is not acted on: no answer, no gate run", async () => {
    const ran = await verify({
      hook_event_name: "SubagentStop",
      last_assistant_message: DONE,
      stop_hook_active: false,
    });
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toBe("");
    expect(await gateLogLines()).toEqual([]);
  });

  test("the hand-back is still gated: a done with nothing changed is denied", async () => {
    // The worker's untouched worktree; the payload carries the session's cwd.
    git(
      repo,
      "worktree",
      "add",
      "-q",
      "-b",
      `worktree-agent-${AGENT}`,
      join(repo, ".claude", "worktrees", `agent-${AGENT}`),
    );
    const ran = await verify({
      hook_event_name: "PreToolUse",
      tool_name: "SubagentHandback",
      tool_input: { message: DONE },
    });
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain('"permissionDecision":"deny"');
    expect(ran.stdout).toContain("No changes detected");
    expect(await gateLogLines()).toHaveLength(1);
  });
});

describe("parseVerifyArgs (coordinator CLI mode)", () => {
  test("no arguments → hook mode", () => {
    expect(parseVerifyArgs([])).toBeNull();
  });

  test("--worktree alone → impl role, no agent, changes required", () => {
    expect(parseVerifyArgs(["--worktree", "/w"])).toEqual({
      worktree: "/w",
      role: "impl",
      agentId: undefined,
      allowEmpty: false,
    });
  });

  test("every flag, any order", () => {
    expect(
      parseVerifyArgs([
        "--allow-empty",
        "--role",
        "test",
        "--agent",
        "a1e4f19f3caa94a6d",
        "--worktree",
        "/w",
      ]),
    ).toEqual({
      worktree: "/w",
      role: "test",
      agentId: "a1e4f19f3caa94a6d",
      allowEmpty: true,
    });
  });

  test("flags without --worktree, or an unknown role, is a usage error", () => {
    expect(typeof parseVerifyArgs(["--role", "test"])).toBe("string");
    expect(typeof parseVerifyArgs(["--worktree", "/w", "--role", "boss"])).toBe(
      "string",
    );
  });
});

describe("cwdMissing", () => {
  test("only a named directory that no longer exists counts", () => {
    expect(cwdMissing(undefined)).toBe(false);
    expect(cwdMissing(tmpdir())).toBe(false);
    expect(cwdMissing("/nonexistent/mimir-worktree-gone")).toBe(true);
  });
});

describe("roleOf", () => {
  test("maps worker agent types to gate roles, unknown → impl", () => {
    expect(roleOf("mimir-impl")).toBe("impl");
    expect(roleOf("mimir-test")).toBe("test");
    expect(roleOf("mimir-review")).toBe("review");
    expect(roleOf("general-purpose")).toBe("impl");
    expect(roleOf(undefined)).toBe("impl");
  });
});

describe("handbackOutput (PreToolUse on SubagentHandback)", () => {
  const message = "Added shout().\n\nSTATUS: done";

  test("skip → silence", () => {
    expect(handbackOutput({ kind: "skip", status: null }, message)).toBeNull();
  });

  test("block → deny with the reason; the worker keeps going", () => {
    expect(
      handbackOutput({ kind: "block", reason: "no tests", blocks: 1 }, message),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "no tests",
      },
    });
  });

  test("pass → allow with the report appended to the hand-back message", () => {
    const out = handbackOutput({ kind: "pass", report: "✅ report" }, message);
    expect(out?.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out?.hookSpecificOutput.updatedInput?.message).toBe(
      `${message}\n\n✅ report`,
    );
  });

  test("exhausted → allow, message ends in STATUS: failed for the coordinator", () => {
    const out = handbackOutput(
      { kind: "exhausted", reason: "gave up", blocks: 3 },
      message,
    );
    const rewritten = out?.hookSpecificOutput.updatedInput?.message ?? "";
    expect(rewritten.startsWith(message)).toBe(true);
    expect(rewritten).toContain("gave up");
    expect(rewritten.trimEnd().endsWith("STATUS: failed")).toBe(true);
  });
});
