import type { On } from "claude-code";
import { expect, test } from "claude-code/testing";
import { handbackRewrite, legVerdict } from "./gate";
import {
  BIN,
  binary,
  CWD,
  denied,
  exited,
  HOME,
  nudged,
  payloads,
  runsOf,
  SESSION,
  session,
} from "./support.test-helpers";

const EDIT = {
  tool: "Edit",
  file_path: "/work/repo/src/a.ts",
  old_string: "a",
  new_string: "b",
} as const;
const EDIT_RESULT = {
  filePath: EDIT.file_path,
  oldString: "a",
  newString: "b",
  originalFile: "a",
  structuredPatch: [],
  userModified: false,
  replaceAll: false,
};

const editTool = (on: On) => {
  const ran: string[] = [];
  on("tool.call", { tool: "Edit" }, (_, e) => {
    ran.push(e.file_path);
    return { result: EDIT_RESULT };
  });
  return ran;
};

test("runs rules and guard with the PreToolUse payload; a clean call reaches the tool untouched", async ($, on) => {
  const statuses = session(on);
  const runs = binary(on);
  const ran = editTool(on);

  const result = await $.tool.call(EDIT);

  const payload = JSON.stringify({
    session_id: SESSION,
    hook_event_name: "PreToolUse",
    cwd: CWD,
    tool_name: "Edit",
    tool_input: {
      file_path: EDIT.file_path,
      old_string: "a",
      new_string: "b",
    },
  });
  expect(runsOf(runs, "rules")).toEqual([
    { argv: [BIN, "rules"], payload, env: { MIMIR_ACTIVE: "1" } },
  ]);
  expect(runsOf(runs, "guard")).toEqual([
    { argv: [BIN, "guard"], payload, env: { MIMIR_ACTIVE: "1" } },
  ]);
  expect(ran).toEqual([EDIT.file_path]);
  expect(result.deny).toBeUndefined();
  expect(result.context).toBeUndefined();
  expect(statuses).toEqual([]);
});

test("a call that names a Claude Code settings file reaches the gates by file: nothing of it on stdin or in argv", async ($, on) => {
  session(on);
  const written = payloads(on);
  const seen: Array<{ argv: readonly string[]; stdin?: string }> = [];
  on("process.run", (_, e) => {
    seen.push({ argv: e.argv, stdin: e.init?.stdin });
    return exited(0);
  });
  editTool(on);
  const settings = "/work/repo/.claude/settings.json";

  await $.tool.call({ ...EDIT, file_path: settings });

  // The edit lands, so reindex.ts's leg runs after the two gates.
  expect(seen.map((run) => run.argv[1])).toEqual(["rules", "guard", "reindex"]);
  for (const run of seen) {
    expect(run.stdin).toBeUndefined();
    expect(run.argv.join(" ")).not.toContain("settings.json");
    const [, , flag, path = ""] = run.argv;
    expect(flag).toBe("--payload");
    expect(path.startsWith(`${HOME}/.mimir/run/${run.argv[1]}-`)).toBe(true);
    expect(JSON.parse(written.get(path) ?? "{}").tool_input.file_path).toBe(
      settings,
    );
  }
  expect(new Set(seen.map((run) => run.argv[3])).size).toBe(3);
});

test("a rules deny refuses the call before the tool runs", async ($, on) => {
  session(on);
  binary(on, (sub) =>
    sub === "rules" ? exited(0, denied("no secrets in source")) : exited(0),
  );
  const ran = editTool(on);

  const result = await $.tool.call(EDIT);

  expect(result.deny).toBe("no secrets in source");
  expect(ran).toEqual([]);
});

test("a guard deny refuses the call too", async ($, on) => {
  session(on);
  binary(on, (sub) =>
    sub === "guard" ? exited(0, denied("review may not write")) : exited(0),
  );
  const ran = editTool(on);

  const result = await $.tool.call(EDIT);

  expect(result.deny).toBe("review may not write");
  expect(ran).toEqual([]);
});

test("a nudge rides the tool's result as context", async ($, on) => {
  session(on);
  binary(on, (sub) =>
    sub === "rules" ? exited(0, nudged("⚠ prefer const")) : exited(0),
  );
  editTool(on);

  const result = await $.tool.call(EDIT);

  expect(result.deny).toBeUndefined();
  expect(result.result).toEqual(EDIT_RESULT);
  expect(result.context).toEqual(["⚠ prefer const"]);
});

test("a gate leg that cannot run fails open with its own status line", async ($, on) => {
  const statuses = session(on);
  payloads(on);
  on("process.run", (_, e) => {
    if (e.argv[1] === "guard") throw new Error("ENOENT");
    return exited(e.argv[1] === "rules" ? 3 : 0);
  });
  const ran = editTool(on);

  const result = await $.tool.call(EDIT);

  expect(result.deny).toBeUndefined();
  expect(ran).toEqual([EDIT.file_path]);
  expect(statuses).toEqual([
    "mimir: rules failed (exit 3)",
    "mimir: role guard failed",
  ]);
});

const AGENT_ID = "a1";
const AGENT_TYPE = "mimir-cc:mimir-impl";
const WORKTREE = "/work/repo/.claude/worktrees/w1";

/**
 * Every `$.state` read and write, whatever its key: a gate path keeps no
 * agent record, so it makes none.
 */
const stateCalls = (on: On) => {
  const written: string[] = [];
  on("state.get", (_, e) => {
    written.push(`get ${String(e.key)} ${String(e.id)}`);
    return { value: { value: undefined, version: 0 } };
  });
  on("state.set", (_, e) => {
    written.push(`set ${String(e.key)} ${String(e.id)}`);
    return { value: { isSet: true as const, version: 1 } };
  });
  return written;
};

test("SubagentStart has no hook: no process runs and no agent record is written", async ($, on) => {
  session(on);
  const written = stateCalls(on);
  const runs = binary(on);
  // The kit's bottom hook throws when nothing answers, so the test answers.
  on("classic.SubagentStart", () => ({}));

  const result = await $.classic.SubagentStart({
    agent_id: AGENT_ID,
    agent_type: AGENT_TYPE,
    cwd: WORKTREE,
  });

  expect(result).toEqual({});
  expect(runs).toEqual([]);
  expect(written).toEqual([]);
});

const STOP = {
  agent_id: AGENT_ID,
  agent_type: AGENT_TYPE,
  agent_transcript_path: "/t/a1.jsonl",
  stop_hook_active: false,
  last_assistant_message: "Done.\n\nSTATUS: done",
  cwd: WORKTREE,
};

test("SubagentStop has no hook: no verify runs and the test's answer stands", async ($, on) => {
  session(on);
  const written = stateCalls(on);
  const runs = binary(on, () =>
    exited(0, JSON.stringify({ decision: "block", reason: "no tests added" })),
  );
  on("classic.SubagentStop", () => ({ additionalContext: ["below"] }));

  const result = await $.classic.SubagentStop(STOP);

  expect(result).toEqual({ additionalContext: ["below"] });
  expect(runs).toEqual([]);
  expect(written).toEqual([]);
});

test("verdict helpers", async () => {
  expect(legVerdict("rules", { status: "rejected", reason: 1 })).toEqual({
    status: "mimir: rules failed",
  });
  expect(
    legVerdict("rules", { status: "fulfilled", value: exited(2).value }),
  ).toEqual({
    status: "mimir: rules failed (exit 2)",
  });
  expect(
    legVerdict("rules", {
      status: "fulfilled",
      value: exited(0, denied("x")).value,
    }),
  ).toEqual({ deny: "x", context: undefined });
  expect(
    legVerdict("rules", {
      status: "fulfilled",
      value: exited(0, nudged("n")).value,
    }),
  ).toEqual({ deny: undefined, context: "n" });

  expect(handbackRewrite("")).toBeNull();
  expect(handbackRewrite(denied("blocked"))).toEqual({
    deny: "blocked",
    message: undefined,
  });
  expect(
    handbackRewrite(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { message: "STATUS: done\n\n✅" },
        },
      }),
    ),
  ).toEqual({ deny: undefined, message: "STATUS: done\n\n✅" });
});
