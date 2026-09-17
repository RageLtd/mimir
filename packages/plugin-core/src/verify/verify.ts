/**
 * The verify gate — decides whether a worker's "done" stands.
 *
 * Runs whether or not any model feels like it, and hands the
 * coordinator numbers instead of claims:
 *
 *   1. STATUS must be `done`; anything else is the coordinator's business
 *   2. the change set (working tree vs base, untracked included)
 *   3. coverage and sanity checks over the diff
 *   4. toolchain resolution per package root — none resolvable → block
 *      (an unverifiable "done" is worth nothing, so silence is the wrong
 *      default)
 *   5. typecheck → test → check per root; first failure blocks with the
 *      output tail as the reason
 *   6. loop guard: after MAX_BLOCKS the worker may stop with
 *      `STATUS: failed` so the coordinator escalates
 */

import { resolveToolchainsForFiles } from "../project/toolchain";
import type { ResolvedToolchain } from "../project/toolchain-types";
import { collectChanges } from "./changes";
import {
  coverageCheck,
  sanityCheck,
  testCounts,
  verifiablePaths,
} from "./checks";
import { type CommandRunner, runCommand, shellArgv, tailLines } from "./exec";
import { clearBlocks, MAX_BLOCKS, noteBlock } from "./loop-guard";
import { formatBlockReason, formatPassReport } from "./report";
import { parseStatus, type WorkerStatus } from "./status";

export type VerifyOptions = {
  /** The worker's working directory (its worktree). */
  readonly worktree: string;
  /** The worker's final message; the STATUS line is parsed from it. */
  readonly lastMessage: string;
  /** Identifies the worker for the loop guard. */
  readonly agentId: string;
  readonly run?: CommandRunner;
  /** Per-command timeout for toolchain commands. */
  readonly commandTimeoutMs?: number;
  /** Lines of output kept in a failure reason. */
  readonly tail?: number;
};

export type CommandRun = {
  readonly root: string;
  readonly kind: "typecheck" | "test" | "check";
  readonly command: string;
  readonly ok: boolean;
};

export type VerifyOutcome =
  | { readonly kind: "skip"; readonly status: WorkerStatus | null }
  | { readonly kind: "pass"; readonly report: string }
  | { readonly kind: "block"; readonly reason: string; readonly blocks: number }
  | {
      readonly kind: "exhausted";
      readonly reason: string;
      readonly blocks: number;
    };

const COMMAND_ORDER = ["typecheck", "test", "check"] as const;

const runToolchain = async (
  toolchain: ResolvedToolchain,
  run: CommandRunner,
  timeoutMs: number | undefined,
  tail: number,
) => {
  const runs: CommandRun[] = [];
  for (const kind of COMMAND_ORDER) {
    const command = toolchain.commands[kind];
    if (!command) continue;
    const result = await run(shellArgv(command), toolchain.root, timeoutMs);
    const ok = result.code === 0 && !result.timedOut;
    runs.push({ root: toolchain.root, kind, command, ok });
    if (!ok) {
      const why = result.timedOut
        ? `timed out after ${timeoutMs}ms`
        : `exit ${result.code}`;
      return {
        runs,
        failure: `\`${command}\` in ${toolchain.root} failed (${why}):\n${tailLines(result, tail)}`,
      };
    }
  }
  return { runs, failure: null };
};

export const runVerify = async (options: VerifyOptions) => {
  const run = options.run ?? runCommand;
  const tail = options.tail ?? 40;
  const status = parseStatus(options.lastMessage);
  if (status !== "done")
    return { kind: "skip", status } satisfies VerifyOutcome;

  const block = async (reason: string) => {
    const blocks = await noteBlock(options.agentId);
    const formatted = formatBlockReason(reason, blocks, MAX_BLOCKS);
    return blocks >= MAX_BLOCKS
      ? ({
          kind: "exhausted",
          reason: formatted,
          blocks,
        } satisfies VerifyOutcome)
      : ({ kind: "block", reason: formatted, blocks } satisfies VerifyOutcome);
  };

  const changes = await collectChanges(run, options.worktree);
  if (!changes) {
    return block(
      `${options.worktree} is not a git worktree, so the change set cannot be verified.`,
    );
  }
  if (changes.files.length === 0) {
    return block(
      "No changes detected. If the task needs no change, say so with STATUS: blocked and explain; a `done` with nothing to verify is not accepted.",
    );
  }

  const failed = coverageCheck(changes.files) ?? sanityCheck(changes.files);
  if (failed) return block(failed.reason);

  const toolchains = await resolveToolchainsForFiles(
    verifiablePaths(changes.files),
    options.worktree,
  );
  const unresolved = [...toolchains.entries()]
    .filter(([, t]) => t === null)
    .map(([root]) => root);
  if (unresolved.length > 0) {
    return block(
      `No verification toolchain detected for: ${unresolved.join(", ")}. Add a [verify] table to mimir.toml (test / check / typecheck commands) so this change can be checked.`,
    );
  }

  const runs: CommandRun[] = [];
  for (const toolchain of toolchains.values()) {
    if (!toolchain) continue;
    const outcome = await runToolchain(
      toolchain,
      run,
      options.commandTimeoutMs,
      tail,
    );
    runs.push(...outcome.runs);
    if (outcome.failure) return block(outcome.failure);
  }

  await clearBlocks(options.agentId);
  return {
    kind: "pass",
    report: formatPassReport({
      base: changes.base,
      files: changes.files,
      counts: testCounts(changes.files),
      runs,
    }),
  } satisfies VerifyOutcome;
};
