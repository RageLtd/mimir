/**
 * OpenCode wiring for workers — the precise role guard before every
 * tool call, and the verify gate on the parent's `task` result.
 *
 * OpenCode has no per-agent hooks and no worktree isolation, so both
 * live in the one plugin and key off the session: a child session
 * (`parentID` set) whose `agent` is a `mimir-*` worker gets that role's
 * guard; a session with an active coordinator state gets the
 * coordinator's. The gate runs in the *parent's* `tool.execute.after`
 * for `task`, because OpenCode can't block a child's stop — the verdict
 * is appended to the tool output the coordinator reads.
 */

import {
  type GuardRole,
  guardDecision,
  isSecretPath,
  readCoordinatorState,
} from "@mimir/plugin-core/guard";
import { runVerify, type VerifyOutcome } from "@mimir/plugin-core/verify";
import { roleForAgentType, workerByName } from "@mimir/plugin-core/workers";

// ── Session → role ──

export type SessionInfo = {
  readonly parentID?: string;
  readonly agent?: string;
};

export type SessionLookup = (sessionID: string) => Promise<SessionInfo | null>;

type SessionClient = {
  readonly session: {
    readonly get: (opts: {
      path: { id: string };
    }) => Promise<{ data?: SessionInfo; error?: unknown }>;
  };
};

/** Narrow the SDK's `session.get` to the two fields the guard needs. */
export const sessionLookupFrom = (client: SessionClient) => {
  const lookup: SessionLookup = (sessionID) =>
    client.session
      .get({ path: { id: sessionID } })
      .then((r) =>
        r.data ? { parentID: r.data.parentID, agent: r.data.agent } : null,
      )
      .catch(() => null);
  return lookup;
};

/**
 * Cached per-session facts. A session's parent and agent never change,
 * so one lookup per session for the plugin's lifetime.
 */
export const createSessionRoles = (lookup: SessionLookup) => {
  const cache = new Map<string, Promise<SessionInfo | null>>();
  const info = (sessionID: string) => {
    let pending = cache.get(sessionID);
    if (!pending) {
      pending = lookup(sessionID);
      cache.set(sessionID, pending);
    }
    return pending;
  };
  return {
    isChild: async (sessionID: string) =>
      (await info(sessionID))?.parentID !== undefined,
    /** The worker role for a child session running a `mimir-*` agent. */
    workerRole: async (sessionID: string) => {
      const s = await info(sessionID);
      if (!s?.parentID || !s.agent) return null;
      return workerByName(s.agent)?.role ?? null;
    },
  };
};

export type SessionRoles = ReturnType<typeof createSessionRoles>;

// ── Before: guard ──

/**
 * Deny reason for this tool call, or null. Worker roles come from the
 * session; the coordinator role from the shared state file. Secret
 * reads are refused for every session, role or not — OpenCode has no
 * plugin-independent read deny for the main agent.
 */
export const guardReason = async (
  roles: SessionRoles,
  input: { readonly tool: string; readonly sessionID: string },
  args: Readonly<Record<string, unknown>>,
  worktree: string,
) => {
  const target = args.filePath;
  if (
    input.tool === "read" &&
    typeof target === "string" &&
    isSecretPath(target)
  ) {
    return `Role guard: ${target} holds credentials. Agents never read secret material.`;
  }

  const role: GuardRole | null =
    (await roles.workerRole(input.sessionID)) ??
    ((await readCoordinatorState(input.sessionID))?.active
      ? "coordinator"
      : null);
  if (!role) return null;

  const coordinator =
    role === "coordinator"
      ? {
          planFileExists: await Bun.file(
            (await readCoordinatorState(input.sessionID))?.planFile ?? "",
          ).exists(),
          workerWorktrees: [],
        }
      : {};
  const decision = guardDecision({
    role,
    toolName: input.tool,
    toolInput: args,
    worktree,
    ...coordinator,
  });
  return decision.allow ? null : decision.reason;
};

// ── After: gate on `task` ──

const TASK_TOOL = "task";

const childSessionId = (metadata: unknown) => {
  if (typeof metadata !== "object" || metadata === null) return null;
  const m = metadata as Record<string, unknown>;
  const id = m.sessionId ?? m.sessionID;
  return typeof id === "string" ? id : null;
};

/** How the verdict reaches the coordinator: appended to the task output. */
export const appendVerdict = (
  output: string,
  outcome: VerifyOutcome,
  childId: string | null,
) => {
  switch (outcome.kind) {
    case "skip":
      return output;
    case "pass":
      return `${output}\n\n${outcome.report}`;
    case "block": {
      const resume = childId
        ? `The worker has stopped. Resume it with the task tool (task_id: ${childId}) and pass the reason above as its instruction.`
        : "The worker has stopped. Resume it with the task tool and pass the reason above as its instruction.";
      return `${output}\n\n${outcome.reason}\n\n${resume}`;
    }
    case "exhausted":
      return `${output}\n\n${outcome.reason}\n\nSTATUS: failed`;
    default:
      return assertNever(outcome);
  }
};

const assertNever = (value: never) => {
  throw new Error(`Unhandled verify outcome: ${String(value)}`);
};

export type GateDeps = {
  readonly verify: typeof runVerify;
  readonly commandTimeoutMs: number;
};

const defaultGateDeps: GateDeps = {
  verify: runVerify,
  commandTimeoutMs: 540_000,
};

/**
 * Run the gate on a finished `task` and rewrite its output in place.
 * Returns the outcome kind for logging, or null when the tool wasn't
 * `task`.
 */
export const gateTaskOutput = async (
  input: {
    readonly tool: string;
    readonly callID: string;
    readonly args: unknown;
  },
  output: { output: string; metadata: unknown },
  worktree: string,
  deps: GateDeps = defaultGateDeps,
) => {
  if (input.tool !== TASK_TOOL) return null;
  const args =
    typeof input.args === "object" && input.args !== null
      ? (input.args as Record<string, unknown>)
      : {};
  const agentType =
    typeof args.subagent_type === "string" ? args.subagent_type : undefined;
  const childId = childSessionId(output.metadata);
  const outcome = await deps.verify({
    role: roleForAgentType(agentType),
    worktree,
    lastMessage: output.output,
    agentId: childId ?? input.callID,
    commandTimeoutMs: deps.commandTimeoutMs,
  });
  output.output = appendVerdict(output.output, outcome, childId);
  return outcome.kind;
};
