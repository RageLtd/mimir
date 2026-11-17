/**
 * The gates inside a subagent: the payload names the session's cwd, the
 * loop's `agent_id` and the type `$.agent.list()` gives it — the binary
 * resolves the worker's worktree itself — and the module keeps no agent
 * record and hooks no classic subagent event.
 */

import type { AgentInfo, On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { HANDBACK_TOOL, UNKNOWN_AGENT_TYPE } from "./gate";
import {
  BIN,
  binary,
  CWD,
  denied,
  exited,
  HOME,
  runsOf,
  SESSION,
} from "./support.test-helpers";

/**
 * The hand-back tool is the engine's own and absent from the laid tools
 * table, so `$.tool.call` cannot name it; declaring it here lets a test
 * raise it as the engine does inside a worker.
 */
declare module "claude-code" {
  interface McpToolInputs {
    SubagentHandback: { message: string };
  }
}

const AGENT_ID = "a1";
const AGENT_TYPE = "mimir-cc:mimir-impl";
const WORKTREE = "/work/repo/.claude/worktrees/w1";
const HANDBACK = "SubagentHandback";
const MESSAGE = "Done.\n\nSTATUS: done";

const LISTED: AgentInfo = {
  id: AGENT_ID,
  description: "implement the change",
  type: AGENT_TYPE,
  status: "running",
};

/**
 * The session, `$.agent.list()` answering `listed`, and every `$.state`
 * read answering a stale agent record, so a gate that still read the
 * retired `agents` key would send the record's cwd and type. `touched`
 * logs every state access, whatever its key.
 */
const subagentSession = (on: On, listed: readonly AgentInfo[] = [LISTED]) => {
  mock.env(on, { HOME });
  on("session.id", () => ({ value: SESSION }));
  on("session.cwd", () => ({ value: CWD }));
  on("agent.list", () => ({ value: [...listed] }));
  const touched: string[] = [];
  on("state.get", (_, e) => {
    touched.push(`get ${String(e.key)} ${String(e.id)}`);
    return {
      value: { value: { cwd: WORKTREE, type: "stale-type" }, version: 1 },
    };
  });
  on("state.set", (_, e) => {
    touched.push(`set ${String(e.key)} ${String(e.id)}`);
    return { value: { isSet: true as const, version: 2 } };
  });
  const statuses: Array<string | undefined> = [];
  on("ui.status", (_, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  return { touched, statuses };
};

const BASH = { tool: "Bash", command: "ls" } as const;
const BASH_INPUT = { command: "ls" };

const bashTool = (on: On) =>
  on("tool.call", { tool: "Bash" }, () => ({
    result: { stdout: "ok", stderr: "", interrupted: false },
  }));

/** The bottom hand-back tool, recording the message it was handed. */
const handbackTool = (on: On) => {
  const handed: unknown[] = [];
  on("tool.call", { tool: HANDBACK_TOOL }, (_, e) => {
    handed.push(e.tool === HANDBACK ? e.message : undefined);
    return { result: "handed back" };
  });
  return handed;
};

const stdinOf = (run: { stdin?: string } | undefined) =>
  JSON.parse(run?.stdin ?? "{}");

const subagentPayload = (
  toolName: string,
  toolInput: object,
  agentType = AGENT_TYPE,
) => ({
  session_id: SESSION,
  hook_event_name: "PreToolUse",
  cwd: CWD,
  tool_name: toolName,
  tool_input: toolInput,
  agent_id: AGENT_ID,
  agent_type: agentType,
});

test("inside a subagent, rules and guard get the session's cwd, the agent's id and its listed type", async ($, on) => {
  const { touched } = subagentSession(on);
  const runs = binary(on);
  bashTool(on);

  const result = await $.tool.call({ ...BASH, agentId: AGENT_ID });

  expect(result.deny).toBeUndefined();
  const expected = subagentPayload("Bash", BASH_INPUT);
  expect(runsOf(runs, "rules").map(stdinOf)).toEqual([expected]);
  expect(runsOf(runs, "guard").map(stdinOf)).toEqual([expected]);
  expect(runsOf(runs, "rules")[0]?.argv).toEqual([BIN, "rules"]);
  expect(touched).toEqual([]);
});

test("a subagent $.agent.list() does not name gets the unknown type", async ($, on) => {
  const { touched } = subagentSession(on, []);
  const runs = binary(on);
  bashTool(on);

  await $.tool.call({ ...BASH, agentId: AGENT_ID });

  const expected = subagentPayload("Bash", BASH_INPUT, UNKNOWN_AGENT_TYPE);
  expect(runsOf(runs, "rules").map(stdinOf)).toEqual([expected]);
  expect(runsOf(runs, "guard").map(stdinOf)).toEqual([expected]);
  expect(touched).toEqual([]);
});

test("on the main loop the payload carries the session's cwd and no agent", async ($, on) => {
  const { touched } = subagentSession(on);
  const runs = binary(on);
  bashTool(on);

  await $.tool.call(BASH);

  const expected = {
    session_id: SESSION,
    hook_event_name: "PreToolUse",
    cwd: CWD,
    tool_name: "Bash",
    tool_input: BASH_INPUT,
  };
  expect(runsOf(runs, "rules").map(stdinOf)).toEqual([expected]);
  expect(runsOf(runs, "guard").map(stdinOf)).toEqual([expected]);
  expect(touched).toEqual([]);
});

test("a hand-back sends verify the session's cwd, the agent's id and its listed type", async ($, on) => {
  const { touched } = subagentSession(on);
  const runs = binary(on);
  const handed = handbackTool(on);

  await $.tool.call({ tool: HANDBACK, message: MESSAGE, agentId: AGENT_ID });

  const verify = runsOf(runs, "verify");
  expect(verify.map((run) => run.argv)).toEqual([[BIN, "verify"]]);
  expect(verify.map(stdinOf)).toEqual([
    subagentPayload(HANDBACK, { message: MESSAGE }),
  ]);
  expect(handed).toEqual([MESSAGE]);
  expect(touched).toEqual([]);
});

test("a hand-back verify denies is refused and never reaches the tool", async ($, on) => {
  const { touched } = subagentSession(on);
  binary(on, (sub) =>
    sub === "verify" ? exited(0, denied("no tests added")) : exited(0),
  );
  const handed = handbackTool(on);

  const result = await $.tool.call({
    tool: HANDBACK,
    message: MESSAGE,
    agentId: AGENT_ID,
  });

  expect(result.deny).toBe("no tests added");
  expect(handed).toEqual([]);
  expect(touched).toEqual([]);
});

test("a hand-back verify passes reaches the tool with the rewritten message", async ($, on) => {
  const { touched } = subagentSession(on);
  const rewritten = `${MESSAGE}\n\n✅ gate passed`;
  binary(on, (sub) =>
    sub === "verify"
      ? exited(
          0,
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              updatedInput: { message: rewritten },
            },
          }),
        )
      : exited(0),
  );
  const handed = handbackTool(on);

  const result = await $.tool.call({
    tool: HANDBACK,
    message: MESSAGE,
    agentId: AGENT_ID,
  });

  expect(result.deny).toBeUndefined();
  expect(handed).toEqual([rewritten]);
  expect(touched).toEqual([]);
});
