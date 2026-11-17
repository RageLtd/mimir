/**
 * What the worker changed — working tree against the base it started
 * from, including uncommitted and untracked files, because workers are
 * not required to commit.
 *
 * Base: the main worktree's HEAD (a worker runs in a `git worktree`
 * branched from it), joined to the worker's HEAD by merge-base. When
 * the worker runs in the main worktree itself, base is HEAD and the
 * diff is simply the uncommitted work.
 *
 * Branch paths: what the integration branch itself committed between
 * trunk and that base. The playbook lands red tests as their own commit
 * before the impl worker starts, so the worker's diff is source-only by
 * design — the coverage check needs to see those earlier commits.
 */

import { join, relative, resolve } from "node:path";
import { isTestFile } from "../rules/test-conventions";
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
  /** Paths committed on the branch between trunk and `base`; empty on trunk. */
  readonly branchPaths: readonly string[];
};

/** Trunk candidates, first that resolves wins. */
const TRUNK_REFS = ["main", "master"] as const;

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

/** merge-base(base, trunk) for the first trunk ref that exists; null without one. */
const resolveTrunkBase = async (
  run: CommandRunner,
  worktree: string,
  base: string,
) => {
  for (const ref of TRUNK_REFS) {
    const found = (await git(run, worktree, "merge-base", base, ref))?.trim();
    if (found && found.length > 0) return found;
  }
  return null;
};

/** Paths the branch committed between trunk and `base`. */
const collectBranchPaths = async (
  run: CommandRunner,
  worktree: string,
  base: string,
) => {
  const trunkBase = await resolveTrunkBase(run, worktree, base);
  if (!trunkBase || trunkBase === base) return [];
  const names = await git(
    run,
    worktree,
    "diff",
    "--name-only",
    trunkBase,
    base,
  );
  return (names ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

type Entry = {
  readonly path: string;
  readonly status: ChangeStatus;
  readonly from?: string;
};

/** Forces git's similarity-based rename detection whatever `diff.renames` says. */
const FIND_RENAMES = "-M";
const RENAME_CODE = "R";

/** Name-status lines as [code, ...paths]; renames/copies list old then new. */
const nameStatusLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length > 1 && (parts[0] ?? "").length > 0);

/** A rename is split into its deletion and its addition; `pairMoves` rejoins them. */
const parseNameStatus = (text: string) => {
  const entries: Entry[] = [];
  for (const [code = "", ...rest] of nameStatusLines(text)) {
    const path = rest[rest.length - 1] ?? "";
    const from = rest[0] ?? "";
    if (code.startsWith(RENAME_CODE) && rest.length > 1) {
      entries.push({ path: from, status: "D" }, { path, status: "A" });
      continue;
    }
    const status: ChangeStatus =
      code.startsWith("A") || code.startsWith("C")
        ? "A"
        : code.startsWith("D")
          ? "D"
          : "M";
    entries.push({ path, status });
  }
  return entries;
};

/** new path → old path for every rename git detected in a name-status diff. */
const renamePairs = (text: string) => {
  const pairs = new Map<string, string>();
  for (const [code = "", from = "", path = ""] of nameStatusLines(text))
    if (code.startsWith(RENAME_CODE) && path.length > 0) pairs.set(path, from);
  return pairs;
};

/**
 * Turn each added path paired with a deleted path into one moved entry.
 * A deleted path is claimed at most once, only a path that is actually
 * deleted can be claimed, and a test file only moves to a path that is
 * still a test file — so a pair never invents a deletion or hides one
 * behind two new files or a non-test path.
 */
const pairMoves = (
  entries: readonly Entry[],
  pairs: ReadonlyMap<string, string>,
) => {
  const deleted = new Set(
    entries.filter((e) => e.status === "D").map((e) => e.path),
  );
  const claimed = new Set<string>();
  const moved = entries.map((e) => {
    const from = e.status === "A" ? pairs.get(e.path) : undefined;
    if (!from || !deleted.has(from) || claimed.has(from)) return e;
    if (isTestFile(from) && !isTestFile(e.path)) return e;
    claimed.add(from);
    return { path: e.path, status: "M", from } satisfies Entry;
  });
  return moved.filter((e) => !(e.status === "D" && claimed.has(e.path)));
};

/**
 * Added and removed lines between two texts, as line multisets. A moved
 * file's old content is not on disk and the pair may be one no single
 * `git diff` shows; the checks only count lines, so order is not needed.
 */
const lineDelta = (before: string, after: string) => {
  const unmatched = new Map<string, number>();
  for (const line of before.split("\n"))
    unmatched.set(line, (unmatched.get(line) ?? 0) + 1);
  const take = (line: string) => {
    const left = unmatched.get(line) ?? 0;
    if (left === 0) return false;
    unmatched.set(line, left - 1);
    return true;
  };
  const added = after.split("\n").filter((line) => !take(line));
  const removed = before.split("\n").filter(take);
  return { added: added.join("\n"), removed: removed.join("\n") };
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
export const collectChanges = async (
  run: CommandRunner,
  worktree: string,
  taskBase?: string,
) => {
  const strictGit = async (...args: string[]) => {
    const result = await run(["git", ...args], worktree);
    if (result.code !== 0 || result.timedOut)
      throw new Error(
        `Cannot collect task base changes: git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
      );
    return result.stdout;
  };
  if (taskBase !== undefined) {
    if (!/^[0-9a-f]{40,64}$/.test(taskBase))
      throw new Error("Invalid task base: expected a full commit ID.");
    await strictGit("cat-file", "-e", `${taskBase}^{commit}`);
    const ancestor = await run(
      ["git", "merge-base", "--is-ancestor", taskBase, "HEAD"],
      worktree,
    );
    if (ancestor.code !== 0 || ancestor.timedOut)
      throw new Error(
        `Invalid task base: ${taskBase} is not a verified ancestor of HEAD. ${ancestor.stderr}`,
      );
  }
  const base = taskBase ?? (await resolveBase(run, worktree));
  if (!base) return null;
  const collectGit = (...args: string[]) =>
    taskBase === undefined ? git(run, worktree, ...args) : strictGit(...args);

  const nameStatus = await collectGit(
    "diff",
    "--name-status",
    FIND_RENAMES,
    base,
  );
  const untracked = (
    (await collectGit("ls-files", "--others", "--exclude-standard")) ?? ""
  )
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
  const listed = [
    ...parseNameStatus(nameStatus ?? ""),
    ...untracked.map((path) => ({ path, status: "A" }) satisfies Entry),
  ];
  const showBase = (path: string) => collectGit("show", `${base}:${path}`);

  const deleted = listed.filter((e) => e.status === "D").map((e) => e.path);

  // A move against an older task base can hide behind a rewrite committed
  // in between, so git's pairing is also asked of HEAD → worktree.
  const head =
    deleted.length > 0
      ? (await collectGit("rev-parse", "HEAD"))?.trim()
      : undefined;
  const headRenames =
    head && head !== base
      ? renamePairs(
          (await collectGit("diff", "--name-status", FIND_RENAMES, "HEAD")) ??
            "",
        )
      : new Map<string, string>();
  const pairs = new Map([...headRenames, ...renamePairs(nameStatus ?? "")]);
  // Untracked files are invisible to git's rename detection; an unstaged
  // move of a test file pairs only on byte-identical content.
  const deletedTests = deleted.filter(isTestFile);
  const untrackedTests = untracked.filter(isTestFile);
  const baseContent = new Map<string, string | null>();
  for (const from of untrackedTests.length > 0 ? deletedTests : [])
    baseContent.set(from, await showBase(from));
  for (const path of deletedTests.length > 0 ? untrackedTests : []) {
    if (pairs.has(path)) continue;
    const content = await readOrNull(join(worktree, path));
    if (content === null) continue;
    const from = deletedTests.find((d) => baseContent.get(d) === content);
    if (from) pairs.set(path, from);
  }
  const entries = pairMoves(listed, pairs);

  const files: ChangedFile[] = [];
  for (const entry of entries) {
    const abs = join(worktree, entry.path);
    const after = entry.status === "D" ? null : await readOrNull(abs);
    if (taskBase !== undefined && entry.status !== "D" && after === null)
      throw new Error(
        `Cannot collect task changes: failed to read ${entry.path}.`,
      );
    const before =
      entry.status === "A" ? null : await showBase(entry.from ?? entry.path);
    const diff =
      before === null
        ? { added: after ?? "", removed: "" }
        : entry.from
          ? lineDelta(before, after ?? "")
          : splitDiff((await collectGit("diff", base, "--", entry.path)) ?? "");
    files.push({
      path: relative(worktree, abs).split("\\").join("/"),
      status: entry.status,
      added: diff.added,
      removed: diff.removed,
      before,
      after,
    });
  }
  // Explicit task boundaries must not borrow tests from earlier branch tasks.
  const branchPaths =
    taskBase === undefined ? await collectBranchPaths(run, worktree, base) : [];
  return { base, files, branchPaths } satisfies ChangeSet;
};
