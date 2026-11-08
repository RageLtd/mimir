/**
 * Role guard — `mimir-cc guard [--role <r>]`, run by the hooks module's
 * `tool.call` hook with the PreToolUse payload.
 *
 * One hook covers every role: `tool.call` fires inside subagents too,
 * and there the module fills in `agent_type` (recorded at SubagentStart),
 * so the role is read from it — a worker's agent name maps to its role,
 * no `agent_type` is the main session (coordinator), and any other
 * subagent is left alone. Plugin-shipped agents cannot carry frontmatter
 * hooks, which is why the role isn't wired per definition. `--role`
 * remains as an explicit override.
 *
 * The coordinator role is silent unless the delegation skill has written
 * an active coordinator state for this session — so ordinary Mimir
 * sessions never feel it. Two of its denials come before the role
 * decision: a state file whose task boundary is malformed (fail closed —
 * a borrowed base would verify the wrong change), and spawning one of
 * Mimir's workers without a captured task. Workers are proven at spawn
 * and at hand-back, not on every tool call; utility agents need no task.
 *
 * The decision itself is `guardDecision` in plugin-core; this file only
 * builds the context from the CC payload (worktree = cwd, plan-file
 * existence, the project's other git worktrees) and speaks the hook
 * protocol. Always exits 0: a crashing guard would block every call.
 */

import {
  type GuardContext,
  type GuardRole,
  guardDecision,
  isGuardRole,
  readCoordinatorState,
} from "@mimir/plugin-core/guard";
import { attempt } from "@mimir/plugin-core/result";
import { errMessage } from "@mimir/plugin-core/util";
import { workerByName } from "@mimir/plugin-core/workers";
import { createLogger } from "./logger";
import { taskProvenance } from "./task-state";
import { bootstrapWorktree } from "./worktree-bootstrap";

const log = createLogger("guard-hook");

type HookInput = {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly agent_type?: string;
};

/** `--role <r>` from argv. Null when missing or unknown. */
export const parseGuardArgs = (args: readonly string[]) => {
  const at = args.indexOf("--role");
  const role = at === -1 ? undefined : args[at + 1];
  return isGuardRole(role) ? role : null;
};

/**
 * Role from the payload: a known worker's role, the coordinator when
 * the call comes from the main session, null for any other subagent.
 */
export const roleFromInput = (input: HookInput) => {
  if (input.agent_type === undefined) return "coordinator" as const;
  return workerByName(input.agent_type)?.role ?? null;
};

/**
 * Worktree roots from `git worktree list --porcelain`, minus the one
 * the coordinator itself runs in. These are where workers write.
 */
export const parseWorktreeList = (porcelain: string, self: string) =>
  porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter((path) => path.length > 0 && path !== self);

const listWorktrees = async (cwd: string) => {
  const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return code === 0 ? parseWorktreeList(text, cwd) : [];
};

export const guardOutput = (decision: ReturnType<typeof guardDecision>) =>
  decision.allow
    ? null
    : {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: decision.reason,
        },
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

/** Coordinator-only fields; null when the role isn't active this session. */
const coordinatorFields = async (sessionId: string, worktree: string) => {
  const state = await readCoordinatorState(sessionId);
  if (!state?.active) return null;
  const planFileExists = await Bun.file(state.planFile).exists();
  const workerWorktrees = await listWorktrees(worktree).catch((err) => {
    log.warn("git worktree list failed", { error: errMessage(err) });
    return [];
  });
  return { planFile: state.planFile, planFileExists, workerWorktrees };
};

// Serialisation boundary: the tool's input arrives as untyped JSON.
const toolInputOf = (input: HookInput) =>
  input.tool_input && typeof input.tool_input === "object"
    ? (input.tool_input as Record<string, unknown>)
    : {};

const SPAWN_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/** True when the call spawns one of Mimir's workers, not a utility agent. */
export const spawnsWorker = (input: HookInput) => {
  if (!input.tool_name || !SPAWN_TOOLS.has(input.tool_name)) return false;
  const subagentType = toolInputOf(input).subagent_type;
  return (
    typeof subagentType === "string" && workerByName(subagentType) !== null
  );
};

/** The coordinator's state-level denial for this call, or null. */
const coordinatorDenial = async (input: HookInput) => {
  const [stateError] = await attempt(() =>
    readCoordinatorState(input.session_id ?? ""),
  );
  if (stateError)
    return {
      allow: false,
      reason: `${errMessage(stateError)} Run \`mimir-cc delegate stop\` to clear it.`,
    } satisfies ReturnType<typeof guardDecision>;
  if (!spawnsWorker(input)) return null;
  const [error] = await attempt(() =>
    taskProvenance(input.session_id, input.cwd ?? process.cwd()),
  );
  if (!error) return null;
  return {
    allow: false,
    reason: `Cannot delegate without task provenance: ${errMessage(error)}`,
  } satisfies ReturnType<typeof guardDecision>;
};

/** Build the guard context; null means "nothing to decide" (stay silent). */
export const buildGuardContext = async (role: GuardRole, input: HookInput) => {
  if (!input.tool_name) return null;
  const worktree = input.cwd ?? process.cwd();
  const toolInput = toolInputOf(input);
  const coordinator =
    role === "coordinator"
      ? await coordinatorFields(input.session_id ?? "", worktree)
      : undefined;
  if (role === "coordinator" && !coordinator) return null;
  return {
    role,
    toolName: input.tool_name,
    toolInput,
    worktree,
    ...coordinator,
  } satisfies GuardContext;
};

export const runGuardHook = async (args: readonly string[]) => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;
  const input = await parseInput(await readStdin());
  const role = parseGuardArgs(args) ?? roleFromInput(input);
  if (!role) return 0;
  if (role === "coordinator") {
    const denied = await coordinatorDenial(input);
    if (denied) {
      log.info("role guard denied", { role, toolName: input.tool_name });
      process.stdout.write(JSON.stringify(guardOutput(denied)));
      return 0;
    }
  }
  // A worker's first call inside its fresh worktree: install deps there
  // once, before any command that would need them.
  if (role !== "coordinator" && input.cwd) {
    const outcome = await bootstrapWorktree(input.cwd);
    if (outcome === "installed" || outcome === "failed") {
      log.info("worktree bootstrap", { role, cwd: input.cwd, outcome });
    }
  }
  const ctx = await buildGuardContext(role, input);
  if (!ctx) return 0;

  const output = guardOutput(guardDecision(ctx));
  if (!output) return 0;
  log.info("role guard denied", { role, toolName: ctx.toolName });
  process.stdout.write(JSON.stringify(output));
  return 0;
};
