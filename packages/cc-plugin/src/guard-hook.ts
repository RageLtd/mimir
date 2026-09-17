/**
 * Role guard — PreToolUse hook, `mimir-cc guard --role <impl|test|review|coordinator>`.
 *
 * Worker roles are wired from each worker definition's frontmatter
 * `hooks`, so the role is static per agent. The coordinator role is
 * wired in settings.json for the main session and is silent unless the
 * delegation skill has written an active coordinator state for this
 * session — so ordinary Mimir sessions never feel it.
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
import { errMessage } from "@mimir/plugin-core/util";
import { createLogger } from "./logger";

const log = createLogger("guard-hook");

type HookInput = {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
};

/** `--role <r>` from argv. Null when missing or unknown. */
export const parseGuardArgs = (args: readonly string[]) => {
  const at = args.indexOf("--role");
  const role = at === -1 ? undefined : args[at + 1];
  return isGuardRole(role) ? role : null;
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

/** Build the guard context; null means "nothing to decide" (stay silent). */
export const buildGuardContext = async (role: GuardRole, input: HookInput) => {
  if (!input.tool_name) return null;
  const worktree = input.cwd ?? process.cwd();
  const toolInput =
    input.tool_input && typeof input.tool_input === "object"
      ? (input.tool_input as Record<string, unknown>)
      : {};
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
  const role = parseGuardArgs(args);
  if (!role) {
    log.error("guard: missing or unknown --role", { args: [...args] });
    return 0;
  }
  const input = await parseInput(await readStdin());
  const ctx = await buildGuardContext(role, input);
  if (!ctx) return 0;

  const output = guardOutput(guardDecision(ctx));
  if (!output) return 0;
  log.info("role guard denied", { role, toolName: ctx.toolName });
  process.stdout.write(JSON.stringify(output));
  return 0;
};
