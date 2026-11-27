/**
 * Delegation helpers the `/delegate` playbook calls from Bash:
 *
 *   mimir-cc delegate start --plan <file>   turn the coordinator role on
 *   mimir-cc delegate task [--refactor]     capture the next task's Git base;
 *                                            --refactor marks the task as a
 *                                            refactor (ends with the task)
 *   mimir-cc delegate allow-deletion <path>…
 *                                            let the current task delete these
 *                                            test files (ends with the task)
 *   mimir-cc delegate allow-removal <path>…
 *                                            let the current task lose
 *                                            assertions in these test files
 *                                            (ends with the task)
 *   mimir-cc delegate status                 show the state for this session
 *   mimir-cc delegate stop                   turn it off
 *   mimir-cc review-prompt <worktree> [--title <t>]
 *                                            print the context-free review
 *                                            prompt for a worker's change
 *
 * The session comes from CLAUDE_CODE_SESSION_ID, which Claude Code sets in
 * Bash subprocesses to the same id its hooks receive — so the state the
 * playbook writes here is the state the guard hook reads.
 */

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  clearCoordinatorState,
  REFACTOR_LABEL,
  TASK_ALLOWANCES,
  writeCoordinatorState,
} from "@mimir/plugin-core/guard";
import { attempt } from "@mimir/plugin-core/result";
import {
  formatWorkerModels,
  type WorkerRoleModels,
} from "@mimir/plugin-core/shared-config";
import { errMessage } from "@mimir/plugin-core/util";
import {
  type ChangeSource,
  type CommandRunner,
  gitChanges,
  runCommand,
} from "@mimir/plugin-core/verify";
import {
  buildReviewPrompt,
  resolveWorkerModels,
} from "@mimir/plugin-core/workers";
import { readTaskState, taskProvenance } from "./task-state";

export const SESSION_ENV = "CLAUDE_CODE_SESSION_ID";

const missingSession = (command: string) =>
  `${command}: ${SESSION_ENV} is not set — run this from a Claude Code session's Bash tool.`;

/** An existing state file the task reader refuses: say so, exit 1, no stack. */
const unreadableState = (error: Error) => {
  console.error(
    `delegate: ${errMessage(error)} Run \`mimir-cc delegate stop\` to clear it.`,
  );
  return 1;
};

export type DelegateArgs =
  | { readonly action: "start"; readonly planFile: string }
  | { readonly action: "task"; readonly refactor: boolean }
  | {
      readonly action: "allow-deletion" | "allow-removal";
      readonly paths: readonly string[];
    }
  | { readonly action: "status" }
  | { readonly action: "stop" };

const REFACTOR_FLAG = "--refactor";

const flagValue = (args: readonly string[], flag: string) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};

/** Parse `delegate …` argv; a string is the usage error. */
export const parseDelegateArgs = (args: readonly string[]) => {
  const [action] = args;
  switch (action) {
    case "start": {
      const plan = flagValue(args, "--plan");
      if (!plan) return "delegate start needs --plan <file>";
      return {
        action: "start",
        planFile: resolve(plan),
      } satisfies DelegateArgs;
    }
    case "status":
      return { action: "status" } satisfies DelegateArgs;
    case "task": {
      const rest = args.slice(1);
      const refactor = rest.length === 1 && rest[0] === REFACTOR_FLAG;
      if (rest.length > 0 && !refactor)
        return `delegate task takes only ${REFACTOR_FLAG}; the host captures HEAD.`;
      return { action: "task", refactor } satisfies DelegateArgs;
    }
    case "allow-deletion":
    case "allow-removal": {
      const paths = args.slice(1);
      if (paths.length === 0)
        return `delegate ${action} needs one or more test file paths, relative to the repository root.`;
      return { action, paths } satisfies DelegateArgs;
    }
    case "stop":
      return { action: "stop" } satisfies DelegateArgs;
    default:
      return "usage: mimir-cc delegate start --plan <file> | task [--refactor] | allow-deletion <path>... | allow-removal <path>... | status | stop";
  }
};

const sessionId = () => {
  const id = process.env[SESSION_ENV];
  if (!id) return null;
  return id;
};

// Re-exported so the playbook's one line stays reachable from the command
// module it is printed by; the formatting itself is editor-agnostic and
// lives in plugin-core.
export { formatWorkerModels };

export const describeState = async (
  session: string,
  planFile: string,
  models: WorkerRoleModels,
) => {
  const exists = await Bun.file(planFile).exists();
  const lines = [
    `delegation active for session ${session}`,
    `plan: ${planFile}`,
    formatWorkerModels(models),
  ];
  if (!exists) {
    lines.push(
      "plan file not written yet — workers cannot be spawned until it exists",
    );
  }
  return lines.join("\n");
};

// The project root is the Bash cwd — the playbook runs this from the repo.
const claudeCodeModels = () => resolveWorkerModels("claudeCode", process.cwd());

const planIdentity = async (path: string) =>
  (await Bun.file(path).exists()) ? realpath(path) : resolve(path);

export const runDelegateCommand = async (
  args: readonly string[],
  run: CommandRunner = runCommand,
) => {
  const parsed = parseDelegateArgs(args);
  if (typeof parsed === "string") {
    console.error(parsed);
    return 1;
  }
  const session = sessionId();
  if (!session) {
    console.error(missingSession("delegate"));
    return 1;
  }

  switch (parsed.action) {
    case "start": {
      const [stateError, state] = await attempt(() => readTaskState(session));
      if (stateError) return unreadableState(stateError);
      const identities = state?.active
        ? await Promise.all([
            planIdentity(state.planFile),
            planIdentity(parsed.planFile),
          ])
        : null;
      if (identities && identities[0] === identities[1]) {
        console.log(
          await describeState(
            session,
            parsed.planFile,
            await claudeCodeModels(),
          ),
        );
        return 0;
      }
      await writeCoordinatorState(session, {
        active: true,
        planFile: parsed.planFile,
      });
      console.log(
        await describeState(session, parsed.planFile, await claudeCodeModels()),
      );
      return 0;
    }
    case "task": {
      const [stateError, state] = await attempt(() => readTaskState(session));
      if (stateError) return unreadableState(stateError);
      if (!state?.active) {
        console.error(
          "delegate task needs an active delegation; call start first.",
        );
        return 1;
      }
      await writeCoordinatorState(session, {
        active: true,
        planFile: state.planFile,
      });
      if (!(await Bun.file(state.planFile).exists())) {
        console.error("delegate task needs the plan file to exist first.");
        return 1;
      }
      const head = await run(
        ["git", "rev-parse", "--verify", "HEAD"],
        process.cwd(),
      );
      const base = head.stdout.trim();
      if (head.code !== 0 || head.timedOut || !/^[0-9a-f]{40,64}$/.test(base)) {
        console.error(
          `Cannot capture task base: ${head.stderr || head.stdout}`,
        );
        return 1;
      }
      const root = await run(
        ["git", "rev-parse", "--show-toplevel"],
        process.cwd(),
      );
      if (root.code !== 0 || root.timedOut || !root.stdout.trim()) {
        console.error(
          `Cannot capture task worktree: ${root.stderr || root.stdout}`,
        );
        return 1;
      }
      await writeCoordinatorState(session, {
        ...state,
        task: {
          base,
          worktree: resolve(root.stdout.trim()),
          ...(parsed.refactor ? { refactor: true } : {}),
        },
      });
      console.log(
        `task started at ${base}${parsed.refactor ? `, ${REFACTOR_LABEL}` : ""}; keep this boundary through retries and review fixes.`,
      );
      return 0;
    }
    case "allow-deletion":
    case "allow-removal": {
      const [stateError, state] = await attempt(() => readTaskState(session));
      if (stateError) return unreadableState(stateError);
      if (!state?.active) {
        console.error(
          `delegate ${parsed.action} needs an active delegation; call start first.`,
        );
        return 1;
      }
      if (!state.task) {
        console.error(
          `delegate ${parsed.action} needs a task boundary; run \`mimir-cc delegate task\` first.`,
        );
        return 1;
      }
      const grant = TASK_ALLOWANCES[parsed.action];
      const allowed = await grant.allow(
        session,
        { ...state, task: state.task },
        parsed.paths,
      );
      console.log(`${grant.label} for this task: ${allowed.join(", ")}`);
      return 0;
    }
    case "status": {
      const [stateError, state] = await attempt(() => readTaskState(session));
      if (stateError) return unreadableState(stateError);
      if (!state?.active) {
        console.log(`no active delegation for session ${session}`);
        return 0;
      }
      console.log(
        await describeState(session, state.planFile, await claudeCodeModels()),
      );
      if (state.task?.refactor) console.log(`current task ${REFACTOR_LABEL}`);
      const deletions = state.task?.allowedDeletions ?? [];
      if (deletions.length > 0)
        console.log(
          `${TASK_ALLOWANCES["allow-deletion"].label}: ${deletions.join(", ")}`,
        );
      const removals = state.task?.allowedRemovals ?? [];
      if (removals.length > 0)
        console.log(
          `${TASK_ALLOWANCES["allow-removal"].label}: ${removals.join(", ")}`,
        );
      return 0;
    }
    case "stop": {
      await clearCoordinatorState(session);
      console.log(`delegation cleared for session ${session}`);
      return 0;
    }
    default:
      return assertNever(parsed);
  }
};

const assertNever = (value: never) => {
  throw new Error(`Unhandled delegate action: ${String(value)}`);
};

/** Split `review-prompt` argv into the worktree and the title. */
export const parseReviewPromptArgs = (args: readonly string[]) => {
  const title = flagValue(args, "--title") ?? "Review this change";
  const positional = args.filter((a, i) => {
    const isFlag = a.startsWith("--");
    const isFlagValue = args[i - 1] === "--title";
    return !isFlag && !isFlagValue;
  });
  const worktree = positional[0];
  return worktree ? { worktree, title } : null;
};

/** `review-prompt <worktree> [--title <t>]` — prints the prompt to stdout. */
export const runReviewPromptCommand = async (
  args: readonly string[],
  run: CommandRunner = runCommand,
  changes: ChangeSource = gitChanges(run),
) => {
  const parsed = parseReviewPromptArgs(args);
  if (!parsed) {
    console.error("usage: mimir-cc review-prompt <worktree> [--title <text>]");
    return 1;
  }
  const { worktree, title } = parsed;
  // Without the session the task boundary is unknowable, and a merge-base
  // diff would quietly review the wrong change set.
  const session = sessionId();
  if (!session) {
    console.error(missingSession("review-prompt"));
    return 1;
  }
  const [error, collected] = await attempt(async () => {
    const task = await taskProvenance(session, resolve(worktree), run);
    const set = await changes.collect(
      task?.worktree ?? resolve(worktree),
      task?.base,
    );
    return { task, set };
  });
  if (error) {
    console.error(`review-prompt: ${errMessage(error)}`);
    return 1;
  }
  const { task, set } = collected;
  if (!set) {
    console.error(`review-prompt: ${worktree} is not a git worktree`);
    return 1;
  }
  const files = set.files.filter(
    (file) => !task || file.path !== task.planPath,
  );
  if (files.length === 0) {
    console.error(`review-prompt: no changes in ${worktree} against its base`);
    return 1;
  }
  console.log(buildReviewPrompt({ title, files }));
  return 0;
};
