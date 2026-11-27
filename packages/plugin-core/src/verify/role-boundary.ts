/**
 * The role-boundary note: when a failed command's output names only files
 * the worker's role may not edit, the block says where the failure is
 * reported and to stop blocked, naming the other worker, only if the
 * worker's own change cannot clear it. The error often lands in the other
 * role's file although the cause is the worker's own — a test calling an
 * export the implementation lacks or shapes differently — so an
 * implementation worker is told to check that first.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { isTestFile } from "../rules/test-conventions";
import type { CommandKind, VerifyRole } from "./verify";

export type RoleBoundaryInput = {
  readonly kind: CommandKind;
  readonly role: VerifyRole;
  /** The failed command's full output, not its tail. */
  readonly output: string;
  /** The directory the command ran in; relative paths resolve against it. */
  readonly cwd: string;
  readonly worktree: string;
  /** Whether a worktree-relative path names an existing file. */
  readonly exists: (path: string) => boolean;
};

/** A path followed by a position: `file:3:5`, `file:3` or `file(3,5)`. */
const LOCATED_PATH = /([^\s:()'"`]+\.[A-Za-z0-9]+)(?::\d+|\(\d+,\d+\))/g;

const namedFiles = (input: RoleBoundaryInput) => {
  const files = new Set<string>();
  for (const match of input.output.matchAll(LOCATED_PATH)) {
    const rel = relative(input.worktree, resolve(input.cwd, match[1] ?? ""));
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    if (input.exists(rel)) files.add(rel);
  }
  return [...files];
};

/** The note to append to the block reason, or null when none applies. */
export const roleBoundaryNote = (input: RoleBoundaryInput) => {
  // A failing test is the test worker's red or the impl worker's job;
  // either way the file it names is not the point.
  if (input.kind === "test" || input.role === "review") return null;
  const files = namedFiles(input);
  if (files.length === 0) return null;
  const ownsTests = input.role === "test";
  if (files.some((file) => isTestFile(file) === ownsTests)) return null;
  const owner = ownsTests ? "mimir-impl" : "mimir-test";
  const ownCause = ownsTests
    ? ""
    : " The failure may still come from your own implementation, such as a missing or mismatched export the test calls; check that first.";
  return `This failure is reported only in files outside the ${input.role} role: ${files.join(", ")}.${ownCause} If your own change cannot clear it, stop with STATUS: blocked and say what change ${owner} must make.`;
};
