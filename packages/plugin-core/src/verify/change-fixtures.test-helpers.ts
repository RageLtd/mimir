/**
 * The stand-in for git in gate tests. A test says what each file held
 * before and after the change, and the gate is handed that as its change
 * set; no command runs.
 *
 * Nothing checks this stand-in against real git. How git's output is read
 * is held by the collector's own tests (changes.test.ts, rename.test.ts),
 * which feed it canned git output.
 */

import { afterAll, afterEach, beforeEach } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChangedFile, ChangeSet, ChangeSource } from "./changes";
import type { CommandRunner } from "./exec";

export const TASK_BASE = "a".repeat(40);
export const OWN_BASE = "b".repeat(40);

const linesOf = (text: string | null) =>
  text === null ? [] : text.split("\n");

/** The lines of `text` left over once each is paired with an equal line of `other`. */
const unpaired = (text: string | null, other: string | null) => {
  const pool = new Map<string, number>();
  for (const line of linesOf(other)) pool.set(line, (pool.get(line) ?? 0) + 1);
  return linesOf(text)
    .filter((line) => {
      const left = pool.get(line) ?? 0;
      if (left === 0) return true;
      pool.set(line, left - 1);
      return false;
    })
    .join("\n");
};

const statusOf = (before: string | null, after: string | null) => {
  if (before === null) return "A";
  if (after === null) return "D";
  return "M";
};

/** One changed file. A null `before` is an added file; a null `after` is a deleted one. */
export const changed = (
  path: string,
  before: string | null,
  after: string | null,
) =>
  ({
    path,
    status: statusOf(before, after),
    added: unpaired(after, before),
    removed: unpaired(before, after),
    before,
    after,
  }) satisfies ChangedFile;

/** A change set measured from `base`; `branchPaths` are paths the branch committed before it. */
export const changeSet = (
  files: readonly ChangedFile[],
  options: {
    readonly base?: string;
    readonly branchPaths?: readonly string[];
  } = {},
) =>
  ({
    base: options.base ?? TASK_BASE,
    files,
    branchPaths: options.branchPaths ?? [],
  }) satisfies ChangeSet;

/** A change source that answers every request with `set`. */
export const fixedChanges = (set: ChangeSet) =>
  ({
    collect: async () => set,
    ownBase: async () => set.base,
  }) satisfies ChangeSource;

/**
 * A change source for a worker in its own worktree: the tree against the
 * task base is `task`, and against the commit it shares with the
 * integration worktree (`own.base`) it is `own`.
 */
export const taskAndOwnChanges = (task: ChangeSet, own: ChangeSet) =>
  ({
    collect: async (_worktree, base) => (base === own.base ? own : task),
    ownBase: async () => own.base,
  }) satisfies ChangeSource;

/**
 * A command runner that scripts toolchain commands by their text and
 * records each one in `seen`. It refuses git: a gate test that reaches
 * git has lost its stand-in.
 */
export const toolchain = (
  outcomes: Record<string, { code: number; out?: string }> = {},
  seen: string[] = [],
) => {
  const run: CommandRunner = async (argv) => {
    if (argv[0] === "git")
      throw new Error(`a gate test ran git: ${argv.join(" ")}`);
    const command = argv[2] ?? "";
    seen.push(command);
    const scripted = outcomes[command] ?? { code: 0 };
    return {
      code: scripted.code,
      stdout: scripted.out ?? "",
      stderr: "",
      timedOut: false,
    };
  };
  return run;
};

export type CannedAnswer =
  | string
  | { readonly code: number; readonly stderr?: string };

/**
 * Canned git for the collector's tests: each answer is keyed by the
 * arguments after `git`, or by `<cwd>$ <arguments>` when the directory
 * matters. A string is stdout with exit 0. A question the test did not
 * can throws, so no test passes on an answer nobody gave.
 */
export const cannedGit = (answers: Record<string, CannedAnswer>) => {
  const run: CommandRunner = async (argv, cwd) => {
    const args = argv.slice(1).join(" ");
    const answer = answers[`${cwd}$ ${args}`] ?? answers[args];
    if (argv[0] !== "git" || answer === undefined)
      throw new Error(`not canned: ${cwd}$ ${argv.join(" ")}`);
    return typeof answer === "string"
      ? { code: 0, stdout: answer, stderr: "", timedOut: false }
      : {
          code: answer.code,
          stdout: "",
          stderr: answer.stderr ?? "",
          timedOut: false,
        };
  };
  return run;
};

/**
 * Per-test home for the loop guard, and project directories that hold
 * only the files the gate reads from disk (the manifest its toolchain is
 * resolved from). Call once at the top of a test file.
 */
export const gateSandbox = () => {
  const dirs: string[] = [];
  const savedHome = process.env.MIMIR_HOME;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "mimir-gate-home-"));
    dirs.push(home);
    process.env.MIMIR_HOME = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.MIMIR_HOME;
    else process.env.MIMIR_HOME = savedHome;
  });
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  return {
    project: async (files: Record<string, string>) => {
      const root = await mkdtemp(join(tmpdir(), "mimir-gate-project-"));
      dirs.push(root);
      for (const [rel, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, rel)), { recursive: true });
        await Bun.write(join(root, rel), content);
      }
      return root;
    },
  };
};
