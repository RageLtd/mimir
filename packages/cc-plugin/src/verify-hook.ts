/**
 * Verify gate — `mimir-cc verify`, wired to two hook events.
 *
 * Primary: PreToolUse on `SubagentHandback`, inside the worker. On
 * Claude Code ≥ 2.1.27x a subagent hands its result back through this
 * tool call, and `tool_input.message` is the worker's final text — the
 * `STATUS:` line lives there. The gate answers in the PreToolUse
 * protocol:
 *
 *   block     → permissionDecision "deny" with the reason — the worker
 *               gets it as the tool error and keeps working
 *   pass      → "allow" with `updatedInput` appending the report to the
 *               message, so the coordinator reads numbers, not claims
 *   exhausted → "allow", message rewritten to end in STATUS: failed
 *   skip      → silence (STATUS was not `done`)
 *
 * Fallback: SubagentStop, for hosts/versions without handback. Same
 * outcomes, spoken as `decision: "block"` or `additionalContext`. When
 * handback is in use, SubagentStop's `last_assistant_message` is
 * boilerplate with no STATUS line, so the gate skips there and never
 * runs twice.
 *
 * Always exits 0. A crashing gate must never wedge a worker.
 */

import { errMessage } from "@mimir/plugin-core/util";
import {
  runVerify,
  type VerifyOutcome,
  type VerifyRole,
} from "@mimir/plugin-core/verify";
import { workerByName } from "@mimir/plugin-core/workers";
import { createLogger } from "./logger";

const log = createLogger("verify-hook");

type HookInput = {
  readonly hook_event_name?: string;
  readonly session_id?: string;
  readonly cwd?: string;
  readonly agent_id?: string;
  readonly agent_type?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly last_assistant_message?: string;
  readonly stop_hook_active?: boolean;
};

export const HANDBACK_TOOL = "SubagentHandback";

/** Toolchain commands get most of the hook's 600 s budget. */
const COMMAND_TIMEOUT_MS = 540_000;

const assertNever = (value: never) => {
  throw new Error(`Unhandled verify outcome: ${String(value)}`);
};

/** SubagentStop protocol. */
export const stopOutput = (outcome: VerifyOutcome) => {
  switch (outcome.kind) {
    case "skip":
      return null;
    case "block":
      return { decision: "block" as const, reason: outcome.reason };
    case "pass":
    case "exhausted":
      return {
        hookSpecificOutput: {
          hookEventName: "SubagentStop" as const,
          additionalContext:
            outcome.kind === "pass" ? outcome.report : outcome.reason,
        },
      };
    default:
      return assertNever(outcome);
  }
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

const readStdin = async () => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const parseInput = (raw: string) =>
  Promise.resolve()
    // Serialisation boundary: the hook payload arrives as untyped JSON.
    .then(() => (raw.trim() ? (JSON.parse(raw) as HookInput) : {}))
    .catch(() => ({}) as HookInput);

/** The worker role behind an agent type; unknown types get the strictest. */
export const roleOf = (agentType: string | undefined) => {
  const role: VerifyRole = workerByName(agentType ?? "")?.role ?? "impl";
  return role;
};

const handbackMessage = (input: HookInput) => {
  const toolInput =
    input.tool_input && typeof input.tool_input === "object"
      ? (input.tool_input as Record<string, unknown>)
      : {};
  return typeof toolInput.message === "string" ? toolInput.message : "";
};

export const runVerifyHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;
  const input = await parseInput(await readStdin());
  const agentId = input.agent_id;
  if (!agentId) {
    log.debug("verify: no agent_id — not inside a subagent, skipping");
    return 0;
  }

  const onHandback =
    input.hook_event_name === "PreToolUse" && input.tool_name === HANDBACK_TOOL;
  if (input.hook_event_name === "PreToolUse" && !onHandback) return 0;

  const message = onHandback
    ? handbackMessage(input)
    : (input.last_assistant_message ?? "");

  const outcome = await runVerify({
    role: roleOf(input.agent_type),
    worktree: input.cwd ?? process.cwd(),
    lastMessage: message,
    agentId,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
  }).catch((err) => {
    log.error("verify gate crashed — letting the worker through", {
      agentId,
      error: errMessage(err),
    });
    return null;
  });
  if (!outcome) return 0;

  const output = onHandback
    ? handbackOutput(outcome, message)
    : stopOutput(outcome);
  log.info("verify gate", {
    agentId,
    agentType: input.agent_type,
    via: onHandback ? "handback" : "stop",
    kind: outcome.kind,
    ...("blocks" in outcome ? { blocks: outcome.blocks } : {}),
  });
  if (output) process.stdout.write(JSON.stringify(output));
  return 0;
};
