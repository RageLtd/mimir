/**
 * What the worker changed — working tree against the base it started
 * from, including uncommitted and untracked files, because workers are
 * not required to commit.
 *
 * Base: the main worktree's HEAD (a worker runs in a `git worktree`
 * branched from it), joined to the worker's HEAD by merge-base. When
 * the worker runs in the main worktree itself, base is HEAD and the
 * diff is simply the uncommitted work.
 */

import { join, relative, resolve } from "node:path";
import type { CommandRunner } from "./exec";

export type ChangeStatus = "A" | "M" | "D";

export type ChangedFile = {
  /** Path relative to the worktree, posix separators. */
  readonly path: string;
  readonly status: ChangeStatus;
  /** Added lines (without the leading `+`), joined by newline. */
  readonly added: string;
  /** Removed lines (without the leading `-`), joined by newline. */
  readonly removed: string;
  /** Full content before the change; null when the file is new. */
  readonly before: string | null;
  /** Full content after the change; null when the file is deleted. */
  readonly after: string | null;
};

export type ChangeSet = {
  readonly base: string;
  readonly files: readonly ChangedFile[];
};

const git = async (run: CommandRunner, cwd: string, ...args: string[]) => {
  const result = await run(["git", ...args], cwd);
  return result.code === 0 ? result.stdout : null;
};

/** The main worktree's path from `git worktree list --porcelain`. */
const mainWorktree = (porcelain: string) => {
  const line = porcelain.split("\n").find((l) => l.startsWith("worktree "));
  return line ? line.slice("worktree ".length).trim() : null;
};

/** merge-base(HEAD, main HEAD), or HEAD when this is the main worktree. */
export const resolveBase = async (run: CommandRunner, worktree: string) => {
  const list = await git(run, worktree, "worktree", "list", "--porcelain");
  const main = list ? mainWorktree(list) : null;
  const head = (await git(run, worktree, "rev-parse", "HEAD"))?.trim() ?? null;
  if (!head) return null;
  if (!main || resolve(main) === resolve(worktree)) return head;
  const mainHead = (await git(run, main, "rev-parse", "HEAD"))?.trim();
  if (!mainHead) return head;
  const base = (
    await git(run, worktree, "merge-base", "HEAD", mainHead)
  )?.trim();
  return base && base.length > 0 ? base : head;
};

const parseNameStatus = (text: string) => {
  const entries: { path: string; status: ChangeStatus }[] = [];
  for (const line of text.split("\n")) {
    const [code, ...rest] = line.split("\t");
    if (!code || rest.length === 0) continue;
    // Renames/copies list old then new; the new path is what changed.
    const path = rest[rest.length - 1] ?? "";
    const status: ChangeStatus =
      code.startsWith("A") || code.startsWith("R") || code.startsWith("C")
        ? "A"
        : code.startsWith("D")
          ? "D"
          : "M";
    entries.push({ path, status });
  }
  return entries;
};

const splitDiff = (diff: string) => {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { added: added.join("\n"), removed: removed.join("\n") };
};

const readOrNull = (filePath: string) =>
  Bun.file(filePath)
    .text()
    .then(
      (text) => text,
      () => null,
    );

/** Collect the worker's change set. Null when `worktree` isn't a git repo. */
export const collectChanges = async (run: CommandRunner, worktree: string) => {
  const base = await resolveBase(run, worktree);
  if (!base) return null;

  const nameStatus = await git(run, worktree, "diff", "--name-status", base);
  const untracked = await git(
    run,
    worktree,
    "ls-files",
    "--others",
    "--exclude-standard",
  );
  const entries = parseNameStatus(nameStatus ?? "");
  for (const path of (untracked ?? "").split("\n")) {
    if (path.trim().length > 0)
      entries.push({ path: path.trim(), status: "A" });
  }

  const files: ChangedFile[] = [];
  for (const entry of entries) {
    const abs = join(worktree, entry.path);
    const after = entry.status === "D" ? null : await readOrNull(abs);
    const before =
      entry.status === "A"
        ? null
        : await git(run, worktree, "show", `${base}:${entry.path}`);
    const diff =
      before === null
        ? { added: after ?? "", removed: "" }
        : splitDiff(
            (await git(run, worktree, "diff", base, "--", entry.path)) ?? "",
          );
    files.push({
      path: relative(worktree, abs).split("\\").join("/"),
      status: entry.status,
      added: diff.added,
      removed: diff.removed,
      before,
      after,
    });
  }
  return { base, files } satisfies ChangeSet;
};
