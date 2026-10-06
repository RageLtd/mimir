/**
 * OpenCode wiring for workers — the precise role guard before every
 * tool call, and the verify gate on the parent's `subagent` result.
 *
 * Both hooks live in the one plugin and key off the session:
 * a child session
 * (`parentID` set) whose `agent` is a `mimir-*` worker gets that role's
 * guard; a session with an active coordinator state gets the
 * coordinator's. The gate runs in the *parent's* `tool.execute.after`
 * for `subagent`, because OpenCode can't block a child's stop — the verdict
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
    readonly get: (opts: { sessionID: string }) => Promise<SessionInfo>;
  };
};

/** Narrow the SDK's `session.get` to the two fields the guard needs. */
export const sessionLookupFrom = (client: SessionClient) => {
  const lookup: SessionLookup = (sessionID) =>
    client.session.get({ sessionID }).catch(() => null);
  return lookup;
};

/**
 * Cache successful session facts; agent-selected/deleted events invalidate
 * them. Transient lookup failures must be retried on the next tool call.
 */
export const createSessionRoles = (lookup: SessionLookup) => {
  const cache = new Map<string, Promise<SessionInfo | null>>();
  const info = (sessionID: string) => {
    let pending = cache.get(sessionID);
    if (!pending) {
      pending = lookup(sessionID).catch(() => null);
      cache.set(sessionID, pending);
      const current = pending;
      void pending.then((result) => {
        if (!result && cache.get(sessionID) === current)
          cache.delete(sessionID);
      });
    }
    return pending;
  };
  return {
    invalidate: (sessionID: string) => cache.delete(sessionID),
    isChild: async (sessionID: string) =>
      (await info(sessionID))?.parentID !== undefined,
    /** The worker role for a child session running a `mimir-*` agent. */
    workerRole: async (sessionID: string, agent?: string) => {
      const s = await info(sessionID);
      const activeAgent = agent ?? s?.agent;
      if (!s?.parentID || !activeAgent) return null;
      return workerByName(activeAgent)?.role ?? null;
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
  input: {
    readonly tool: string;
    readonly sessionID: string;
    readonly agent?: string;
  },
  args: Readonly<Record<string, unknown>>,
  worktree: string,
) => {
  const target = args.filePath ?? args.file_path ?? args.path;
  if (
    (input.tool === "read" || input.tool === "Read") &&
    typeof target === "string" &&
    isSecretPath(target)
  ) {
    return `Role guard: ${target} holds credentials. Agents never read secret material.`;
  }

  // Shared guards use legacy cross-host tool names internally.
  const toolName =
    input.tool === "subagent"
      ? "task"
      : input.tool === "shell"
        ? "bash"
        : input.tool === "patch"
          ? "apply_patch"
          : input.tool;
  const base = { toolName, toolInput: args, worktree };

  const workerRole = await roles.workerRole(input.sessionID, input.agent);
  if (workerRole)
    return denyReason(guardDecision({ ...base, role: workerRole }));

  const state = await readCoordinatorState(input.sessionID);
  if (!state?.active) return null;
  const role: GuardRole = "coordinator";
  return denyReason(
    guardDecision({
      ...base,
      role,
      planFile: state.planFile,
      planFileExists: await Bun.file(state.planFile).exists(),
      workerWorktrees: [],
    }),
  );
};

const denyReason = (decision: ReturnType<typeof guardDecision>) =>
  decision.allow ? null : decision.reason;

// ── After: gate on `subagent` ──

const SUBAGENT_TOOL = "subagent";

const childSessionId = (metadata: unknown) => {
  if (typeof metadata !== "object" || metadata === null) return null;
  const m = metadata as Record<string, unknown>;
  const id = m.sessionId ?? m.sessionID;
  return typeof id === "string" ? id : null;
};

/** How the verdict reaches the coordinator: appended to the subagent output. */
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
      const handle = childId ? ` (sessionID: ${childId})` : "";
      const resume = `The worker has stopped. Resume it with the subagent tool${handle} and pass the reason above as its prompt.`;
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
 * Run the gate on a finished `subagent` and rewrite its output in place.
 * Returns the outcome kind for logging, or null when the tool wasn't
 * `subagent` (or it returned a running background session).
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
  if (input.tool !== SUBAGENT_TOOL) return null;
  if (
    typeof output.metadata === "object" &&
    output.metadata !== null &&
    "status" in output.metadata &&
    output.metadata.status === "running"
  )
    return null;
  const args =
    typeof input.args === "object" && input.args !== null
      ? (input.args as Record<string, unknown>)
      : {};
  const agentType = typeof args.agent === "string" ? args.agent : undefined;
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
