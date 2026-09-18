/**
 * Delegation helpers the `/delegate` playbook calls from Bash:
 *
 *   mimir-cc delegate start --plan <file>   turn the coordinator role on
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

import { resolve } from "node:path";
import {
  clearCoordinatorState,
  readCoordinatorState,
  writeCoordinatorState,
} from "@mimir/plugin-core/guard";
import {
  formatWorkerModels,
  type WorkerRoleModels,
} from "@mimir/plugin-core/shared-config";
import { collectChanges, runCommand } from "@mimir/plugin-core/verify";
import {
  buildReviewPrompt,
  resolveWorkerModels,
} from "@mimir/plugin-core/workers";

export const SESSION_ENV = "CLAUDE_CODE_SESSION_ID";

export type DelegateArgs =
  | { readonly action: "start"; readonly planFile: string }
  | { readonly action: "status" }
  | { readonly action: "stop" };

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
    case "stop":
      return { action: "stop" } satisfies DelegateArgs;
    default:
      return "usage: mimir-cc delegate start --plan <file> | status | stop";
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

export const runDelegateCommand = async (args: readonly string[]) => {
  const parsed = parseDelegateArgs(args);
  if (typeof parsed === "string") {
    console.error(parsed);
    return 1;
  }
  const session = sessionId();
  if (!session) {
    console.error(
      `delegate: ${SESSION_ENV} is not set — run this from a Claude Code session's Bash tool.`,
    );
    return 1;
  }

  switch (parsed.action) {
    case "start": {
      await writeCoordinatorState(session, {
        active: true,
        planFile: parsed.planFile,
      });
      console.log(
        await describeState(session, parsed.planFile, await claudeCodeModels()),
      );
      return 0;
    }
    case "status": {
      const state = await readCoordinatorState(session);
      if (!state?.active) {
        console.log(`no active delegation for session ${session}`);
        return 0;
      }
      console.log(
        await describeState(session, state.planFile, await claudeCodeModels()),
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
export const runReviewPromptCommand = async (args: readonly string[]) => {
  const parsed = parseReviewPromptArgs(args);
  if (!parsed) {
    console.error("usage: mimir-cc review-prompt <worktree> [--title <text>]");
    return 1;
  }
  const { worktree, title } = parsed;
  const changes = await collectChanges(runCommand, resolve(worktree));
  if (!changes) {
    console.error(`review-prompt: ${worktree} is not a git worktree`);
    return 1;
  }
  if (changes.files.length === 0) {
    console.error(`review-prompt: no changes in ${worktree} against its base`);
    return 1;
  }
  console.log(buildReviewPrompt({ title, files: changes.files }));
  return 0;
};
