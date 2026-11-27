/**
 * Verify gate — `mimir-cc verify`, run by the hooks module with its
 * payload on stdin.
 *
 * `tool.call` on `SubagentHandback`, inside the worker (the PreToolUse
 * payload). A subagent hands its result back through this
 * tool call, and `tool_input.message` is the worker's final text — the
 * `STATUS:` line lives there. The gate answers in the PreToolUse
 * protocol, which the module maps onto the call:
 *
 *   block     → permissionDecision "deny" with the reason — the worker
 *               gets it as the tool error and keeps working
 *   pass      → "allow" with `updatedInput` appending the report to the
 *               message, so the coordinator reads numbers, not claims
 *   exhausted → "allow", message rewritten to end in STATUS: failed
 *   skip      → silence (STATUS was not `done`)
 *
 * Any other payload gets no answer. The payload's `cwd` is the session's
 * directory; the gate runs in the subagent's worktree (`withAgentCwd`).
 *
 * Always exits 0 as a hook. A crashing gate must never wedge a worker.
 *
 * Coordinator CLI mode — `mimir-cc verify --worktree <path> [--role
 * impl|test] [--agent <id>] [--allow-empty]` — runs the same gate on
 * demand and prints the report: re-check a retained worktree after an
 * exogenous failure (a flaky test, a rate limit), or with `--allow-empty`
 * run the merged tree's toolchain as the post-merge integration check.
 * Exit 0 on pass, 1 on block.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { attempt } from "@mimir/plugin-core/result";
import { errMessage } from "@mimir/plugin-core/util";
import {
  type CommandRunner,
  clearBlocks,
  parseStatus,
  runCommand,
  runVerify,
  type VerifyOutcome,
  type VerifyRole,
} from "@mimir/plugin-core/verify";
import { roleForAgentType } from "@mimir/plugin-core/workers";
import { withAgentCwd } from "./agent-worktree";
import { readPayload } from "./hook-payload";
import { createLogger } from "./logger";
import { taskProvenance } from "./task-state";

const log = createLogger("verify-hook");

type HookInput = {
  readonly hook_event_name?: string;
  readonly session_id?: string;
  readonly cwd?: string;
  readonly agent_id?: string;
  readonly agent_type?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
};

export const HANDBACK_TOOL = "SubagentHandback";

/** Toolchain commands get most of the hook's 600 s budget. */
const COMMAND_TIMEOUT_MS = 540_000;

const assertNever = (value: never) => {
  throw new Error(`Unhandled verify outcome: ${String(value)}`);
};

/** PreToolUse-on-handback protocol; `message` is the worker's text. */
export const handbackOutput = (outcome: VerifyOutcome, message: string) => {
  switch (outcome.kind) {
    case "skip":
      return null;
    case "block":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: outcome.reason,
        },
      };
    case "pass":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "allow" as const,
          updatedInput: { message: `${message}\n\n${outcome.report}` },
        },
      };
    case "exhausted":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "allow" as const,
          updatedInput: {
            message: `${message}\n\n${outcome.reason}\n\nSTATUS: failed`,
          },
        },
      };
    default:
      return assertNever(outcome);
  }
};

const parseInput = (raw: string) =>
  Promise.resolve()
    // Serialisation boundary: the hook payload arrives as untyped JSON.
    .then(() => (raw.trim() ? (JSON.parse(raw) as HookInput) : {}))
    .catch(() => ({}) as HookInput);

/** The worker role behind an agent type; unknown types get the strictest. */
export const roleOf = (agentType: string | undefined) => {
  const role: VerifyRole = roleForAgentType(agentType);
  return role;
};

/**
 * A hook payload whose own cwd no longer exists: one that names a
 * worktree as `cwd` after the coordinator collected and removed it. Nothing there to
 * verify. (A payload carrying the session's directory instead is covered
 * by `withAgentCwd`'s `missing`.)
 */
export const cwdMissing = (cwd?: string) =>
  cwd !== undefined && !existsSync(cwd);

const CLI_ROLES: readonly VerifyRole[] = ["impl", "test"];
const CLI_AGENT_ID = "coordinator";
const CLI_USAGE =
  "usage: mimir-cc verify --worktree <path> [--role impl|test] [--agent <id>] [--allow-empty]";

export type VerifyCliArgs = {
  readonly worktree: string;
  readonly role: VerifyRole;
  readonly agentId: string | undefined;
  readonly allowEmpty: boolean;
};

const flagValue = (args: readonly string[], flag: string) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};

/** Null → hook mode (stdin). A string is the usage error. */
export const parseVerifyArgs = (args: readonly string[]) => {
  if (args.length === 0) return null;
  const worktree = flagValue(args, "--worktree");
  if (!worktree) return CLI_USAGE;
  const roleFlag = flagValue(args, "--role") ?? "impl";
  const role = CLI_ROLES.find((r) => r === roleFlag);
  if (!role) return CLI_USAGE;
  return {
    worktree,
    role,
    agentId: flagValue(args, "--agent"),
    allowEmpty: args.includes("--allow-empty"),
  } satisfies VerifyCliArgs;
};

/** What the gate entry reaches outside itself for: the gate, and git. */
export type GateEntryDeps = {
  readonly verify: typeof runVerify;
  readonly run: CommandRunner;
};

const REAL_DEPS = {
  verify: runVerify,
  run: runCommand,
} satisfies GateEntryDeps;

const runVerifyCli = async (args: VerifyCliArgs, deps: GateEntryDeps) => {
  const agentId = args.agentId ?? CLI_AGENT_ID;
  // A worker's block count is its own; the coordinator's shared id
  // starts clean every time so old runs can't exhaust a new one.
  if (!args.agentId) await clearBlocks(agentId);
  const outcome = await verifyForSession(
    process.env.CLAUDE_CODE_SESSION_ID,
    {
      role: args.role,
      worktree: resolve(args.worktree),
      lastMessage: "STATUS: done",
      agentId,
      allowEmpty: args.allowEmpty,
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
    },
    deps,
  );
  switch (outcome.kind) {
    case "pass":
      console.log(outcome.report);
      return 0;
    case "block":
    case "exhausted":
      console.log(outcome.reason);
      return 1;
    case "skip":
      console.error("verify: nothing to do");
      return 1;
    default:
      return assertNever(outcome);
  }
};

/**
 * The gate for one hand-back or manual run, given what the session's task
 * boundary says: its base, its allowances, its refactor mark, and which
 * worktree the worker's own change is measured against.
 */
export const verifyForSession = async (
  session: string | undefined,
  options: Parameters<typeof runVerify>[0],
  deps: GateEntryDeps = REAL_DEPS,
) => {
  if (options.role === "review" || parseStatus(options.lastMessage) !== "done")
    return deps.verify(options);
  const [error, task] = await attempt(() =>
    taskProvenance(session, options.worktree, deps.run),
  );
  if (error)
    return {
      kind: "block",
      blocks: 0,
      reason: `Cannot verify task provenance: ${errMessage(error)}`,
    } satisfies VerifyOutcome;
  // A worker is judged on its own change, from where its branch meets the
  // integration HEAD. The integration worktree itself is the task-level
  // check: there that meeting point is HEAD, which would hide every commit
  // the task collected, so its test-change rules read from the task base.
  const integrationWorktree =
    task && task.worktree !== task.integrationWorktree
      ? task.integrationWorktree
      : undefined;
  return deps.verify({
    ...options,
    base: task?.base,
    allowedDeletions: task?.allowedDeletions,
    allowedRemovals: task?.allowedRemovals,
    refactor: task?.refactor,
    integrationWorktree,
    worktree: task?.worktree ?? options.worktree,
  });
};

const handbackMessage = (input: HookInput) => {
  const toolInput =
    input.tool_input && typeof input.tool_input === "object"
      ? (input.tool_input as Record<string, unknown>)
      : {};
  return typeof toolInput.message === "string" ? toolInput.message : "";
};

/**
 * The hook's answer to one payload: the PreToolUse output for a gated
 * hand-back, or null when the payload is not one to answer.
 */
export const answerHandback = async (
  raw: string,
  deps: GateEntryDeps = REAL_DEPS,
) => {
  const payload = await parseInput(raw);
  const agentId = payload.agent_id;
  if (!agentId) {
    log.debug("verify: no agent_id — not inside a subagent, skipping");
    return null;
  }
  if (
    payload.hook_event_name !== "PreToolUse" ||
    payload.tool_name !== HANDBACK_TOOL
  )
    return null;
  if (cwdMissing(payload.cwd)) {
    log.info("verify: worktree already collected — skipping late re-fire", {
      agentId,
      cwd: payload.cwd,
    });
    return null;
  }

  // A worker without its worktree: the coordinator already collected it.
  // The session's tree is not the worker's change set, so no gate runs.
  const { input, missing } = await withAgentCwd(payload, deps.run);
  if (missing) return null;
  const message = handbackMessage(input);

  const outcome = await verifyForSession(
    input.session_id,
    {
      role: roleOf(input.agent_type),
      worktree: input.cwd ?? process.cwd(),
      lastMessage: message,
      agentId,
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
    },
    deps,
  ).catch((err) => {
    log.error("verify gate crashed — letting the worker through", {
      agentId,
      error: errMessage(err),
    });
    return null;
  });
  if (!outcome) return null;

  log.info("verify gate", {
    agentId,
    agentType: input.agent_type,
    worktree: input.cwd,
    kind: outcome.kind,
    ...("blocks" in outcome ? { blocks: outcome.blocks } : {}),
  });
  return handbackOutput(outcome, message);
};

export const runVerifyHook = async (
  args: readonly string[] = [],
  deps: GateEntryDeps = REAL_DEPS,
) => {
  const cli = parseVerifyArgs(args);
  if (typeof cli === "string") {
    console.error(cli);
    return 1;
  }
  if (cli) return runVerifyCli(cli, deps);

  if (process.env.MIMIR_ACTIVE !== "1") return 0;
  const output = await answerHandback(await readPayload(), deps);
  if (output) process.stdout.write(JSON.stringify(output));
  return 0;
};
