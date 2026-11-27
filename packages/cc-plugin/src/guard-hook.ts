/**
 * Role guard — `mimir-cc guard [--role <r>]`, run by the hooks module's
 * `tool.call` hook with the PreToolUse payload.
 *
 * One hook covers every role: `tool.call` fires inside subagents too,
 * and there the module fills in `agent_type` (from `$.agent.list()`),
 * so the role is read from it — a worker's agent name maps to its role,
 * no `agent_type` is the main session (coordinator), and any other
 * subagent has no role rules. Plugin-shipped agents cannot carry frontmatter
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
 * After the role decision comes the skill-before-edit rule: each `Skill`
 * call is recorded for the loop that made it (the main loop, or the
 * subagent by `agent_id`), and an edit whose skill that loop has not
 * loaded is refused. Mimir's workers are exempt — their prompts carry the
 * conventions and their role rules bound what they may touch — except
 * that the implementer in a task marked as a refactor needs `refactor`.
 *
 * The decision itself is `guardDecision` in plugin-core; this file only
 * builds the context from the CC payload (worktree = cwd, moved into a
 * subagent's own worktree by `withAgentCwd`; plan-file
 * existence, the project's other git worktrees) and speaks the hook
 * protocol. Every command the guard runs goes through the runner it is
 * handed. Always exits 0: a crashing guard would block every call.
 */

import { resolve } from "node:path";
import {
  editSkillDecision,
  type GuardContext,
  type GuardDecision,
  type GuardRole,
  guardDecision,
  isGuardRole,
  readCoordinatorState,
  readLoadedSkills,
  recordLoadedSkill,
} from "@mimir/plugin-core/guard";
import { attempt } from "@mimir/plugin-core/result";
import { eventMatchesTool } from "@mimir/plugin-core/rules";
import { errMessage, expandHomePath } from "@mimir/plugin-core/util";
import { type CommandRunner, runCommand } from "@mimir/plugin-core/verify";
import { workerByName } from "@mimir/plugin-core/workers";
import { withAgentCwd } from "./agent-worktree";
import { readPayload } from "./hook-payload";
import { createLogger } from "./logger";
import { taskProvenance } from "./task-state";
import { bootstrapWorktree } from "./worktree-bootstrap";

const log = createLogger("guard-hook");

type HookInput = {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly agent_id?: string;
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

const listWorktrees = async (cwd: string, run: CommandRunner) => {
  const result = await run(["git", "worktree", "list", "--porcelain"], cwd);
  return result.code === 0 && !result.timedOut
    ? parseWorktreeList(result.stdout, cwd)
    : [];
};

export const guardOutput = (decision: GuardDecision) =>
  decision.allow
    ? null
    : {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: decision.reason,
        },
      };

const parseInput = (raw: string) =>
  Promise.resolve()
    // Serialisation boundary: the hook payload arrives as untyped JSON.
    .then(() => (raw.trim() ? (JSON.parse(raw) as HookInput) : {}))
    .catch(() => ({}) as HookInput);

/** Coordinator-only fields; null when the role isn't active this session. */
const coordinatorFields = async (
  sessionId: string,
  worktree: string,
  run: CommandRunner,
) => {
  const state = await readCoordinatorState(sessionId);
  if (!state?.active) return null;
  const planFileExists = await Bun.file(state.planFile).exists();
  const workerWorktrees = await listWorktrees(worktree, run).catch((err) => {
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
const coordinatorDenial = async (input: HookInput, run: CommandRunner) => {
  const [stateError] = await attempt(() =>
    readCoordinatorState(input.session_id ?? ""),
  );
  if (stateError)
    return {
      allow: false,
      reason: `${errMessage(stateError)} Run \`mimir-cc delegate stop\` to clear it.`,
    } satisfies GuardDecision;
  if (!spawnsWorker(input)) return null;
  const [error] = await attempt(() =>
    taskProvenance(input.session_id, input.cwd ?? process.cwd(), run),
  );
  if (!error) return null;
  return {
    allow: false,
    reason: `Cannot delegate without task provenance: ${errMessage(error)}`,
  } satisfies GuardDecision;
};

/** Build the guard context; null means "nothing to decide" (stay silent). */
export const buildGuardContext = async (
  role: GuardRole,
  input: HookInput,
  run: CommandRunner = runCommand,
) => {
  if (!input.tool_name) return null;
  const worktree = input.cwd ?? process.cwd();
  const toolInput = toolInputOf(input);
  const coordinator =
    role === "coordinator"
      ? await coordinatorFields(input.session_id ?? "", worktree, run)
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

/** The role's denial for this call, or null; no role means no role rules. */
const roleDenial = async (
  role: GuardRole | null,
  input: HookInput,
  run: CommandRunner,
) => {
  if (!role) return null;
  if (role === "coordinator") {
    const denied = await coordinatorDenial(input, run);
    if (denied) return denied;
  }
  // A worker's first call inside its fresh worktree: install deps there
  // once, before any command that would need them.
  if (role !== "coordinator" && input.cwd) {
    const outcome = await bootstrapWorktree(input.cwd, run);
    if (outcome === "installed" || outcome === "failed") {
      log.info("worktree bootstrap", { role, cwd: input.cwd, outcome });
    }
  }
  const ctx = await buildGuardContext(role, input, run);
  if (!ctx) return null;
  const decision = guardDecision(ctx);
  return decision.allow ? null : decision;
};

const skillLoop = (input: HookInput) => ({
  sessionId: input.session_id ?? "",
  agentId: input.agent_id,
});

/** Remember a `Skill` call for the loop that made it. */
const recordSkillCall = async (input: HookInput) => {
  const skill = toolInputOf(input).skill;
  if (input.tool_name !== "Skill" || typeof skill !== "string" || !skill)
    return;
  const [error] = await attempt(() =>
    recordLoadedSkill(skillLoop(input), skill),
  );
  // The call itself goes ahead; the broken record refuses the next edit.
  if (error)
    log.warn("could not record the loaded skill", {
      skill,
      error: errMessage(error),
    });
};

/** True when this session's delegation has a current task marked as a refactor. */
const inRefactorTask = async (sessionId: string) =>
  (await readCoordinatorState(sessionId))?.task?.refactor === true;

/** The skill-before-edit rule's denial for a file write, or null. */
const editSkillDenial = async (input: HookInput, refactor: boolean) => {
  if (!input.tool_name || !eventMatchesTool("file", input.tool_name))
    return null;
  const raw = toolInputOf(input).file_path;
  if (typeof raw !== "string" || !raw) return null;
  const path = resolve(input.cwd ?? process.cwd(), expandHomePath(raw));
  const [error, recorded] = await attempt(() =>
    readLoadedSkills(skillLoop(input)),
  );
  if (error)
    return { allow: false, reason: errMessage(error) } satisfies GuardDecision;
  // A worker's definition preloads its skills, so no Skill call records them.
  const preloaded = workerByName(input.agent_type ?? "")?.skills ?? [];
  const decision = editSkillDecision(path, [...recorded, ...preloaded], {
    refactor,
  });
  return decision.allow ? null : decision;
};

/**
 * The skill-before-edit rule for this loop's role: Mimir's workers are
 * exempt, except that the implementer in a refactor task needs `refactor`.
 */
const roleEditSkillDenial = async (
  role: GuardRole | null,
  input: HookInput,
) => {
  if (role === null || role === "coordinator")
    return editSkillDenial(input, false);
  if (role !== "impl") return null;
  const [error, refactor] = await attempt(() =>
    inRefactorTask(input.session_id ?? ""),
  );
  if (error)
    return { allow: false, reason: errMessage(error) } satisfies GuardDecision;
  return refactor ? editSkillDenial(input, true) : null;
};

/**
 * The guard's answer to one PreToolUse payload: the hook output to print,
 * or null to stay silent. `run` answers every command the guard runs.
 */
export const answerGuard = async (
  raw: string,
  { run }: { readonly run: CommandRunner },
  args: readonly string[] = [],
) => {
  const { input } = await withAgentCwd(await parseInput(raw), run);
  await recordSkillCall(input);
  const role = parseGuardArgs(args) ?? roleFromInput(input);
  const denied =
    (await roleDenial(role, input, run)) ??
    (await roleEditSkillDenial(role, input));
  if (!denied) return null;
  log.info("guard denied", { role, toolName: input.tool_name });
  return guardOutput(denied);
};

export const runGuardHook = async (args: readonly string[]) => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;
  const output = await answerGuard(
    await readPayload(),
    { run: runCommand },
    args,
  );
  if (output) process.stdout.write(JSON.stringify(output));
  return 0;
};
