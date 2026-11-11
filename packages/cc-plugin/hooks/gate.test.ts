import type { On } from "claude-code";
import { expect, test } from "claude-code/testing";
import { handbackRewrite, legVerdict } from "./gate";
import {
  BIN,
  binary,
  CWD,
  denied,
  exited,
  nudged,
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
    { argv: [BIN, "rules"], stdin: payload, env: { MIMIR_ACTIVE: "1" } },
  ]);
  expect(runsOf(runs, "guard")).toEqual([
    { argv: [BIN, "guard"], stdin: payload, env: { MIMIR_ACTIVE: "1" } },
  ]);
  expect(ran).toEqual([EDIT.file_path]);
  expect(result.deny).toBeUndefined();
  expect(result.context).toBeUndefined();
  expect(statuses).toEqual([]);
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

test("records a subagent's cwd and type when it starts", async ($, on) => {
  session(on);
  const written: unknown[] = [];
  on("state.set", { key: "agents" }, (_, e) => {
    written.push({ id: e.id, value: e.value });
    return { value: { isSet: true as const, version: 1 } };
  });
  on("classic.SubagentStart", () => ({}));

  await $.classic.SubagentStart({
    agent_id: "a1",
    agent_type: "mimir-cc:mimir-impl",
    cwd: "/work/repo/.claude/worktrees/w1",
  });

  expect(written).toEqual([
    {
      id: "a1",
      value: {
        cwd: "/work/repo/.claude/worktrees/w1",
        type: "mimir-cc:mimir-impl",
      },
    },
  ]);
});

const STOP = {
  agent_id: "a1",
  agent_type: "mimir-cc:mimir-impl",
  agent_transcript_path: "/t/a1.jsonl",
  stop_hook_active: false,
  last_assistant_message: "Done.\n\nSTATUS: done",
  cwd: "/work/repo/.claude/worktrees/w1",
};

test("SubagentStop: the verify gate's block stops the worker with the reason", async ($, on) => {
  session(on);
  const runs = binary(on, () =>
    exited(0, JSON.stringify({ decision: "block", reason: "no tests added" })),
  );
  on("classic.SubagentStop", () => ({}));

  const result = await $.classic.SubagentStop(STOP);

  expect(result).toEqual({ block: "no tests added" });
  const [run] = runsOf(runs, "verify");
  expect(run?.argv).toEqual([BIN, "verify"]);
  expect(JSON.parse(run?.stdin ?? "{}")).toMatchObject({
    hook_event_name: "SubagentStop",
    agent_id: "a1",
    cwd: STOP.cwd,
    last_assistant_message: STOP.last_assistant_message,
  });
});

test("SubagentStop: a pass hands the report on as context; silence passes through", async ($, on) => {
  session(on);
  let stdout = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SubagentStop",
      additionalContext: "✅ gate passed",
    },
  });
  binary(on, () => exited(0, stdout));
  on("classic.SubagentStop", () => ({ additionalContext: ["below"] }));

  expect(await $.classic.SubagentStop(STOP)).toEqual({
    additionalContext: ["below", "✅ gate passed"],
  });

  stdout = "";
  expect(await $.classic.SubagentStop(STOP)).toEqual({
    additionalContext: ["below"],
  });
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
