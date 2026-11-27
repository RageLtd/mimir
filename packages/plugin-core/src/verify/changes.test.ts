/**
 * How the collector reads git: which base it settles on, and what change
 * set it builds from git's answers and the files on disk. Git's answers
 * are canned, so no command runs. What git itself would answer is not
 * checked here.
 */

import { describe, expect, test } from "bun:test";
import {
  cannedGit,
  gateSandbox,
  TASK_BASE,
} from "./change-fixtures.test-helpers";
import { collectChanges, resolveBase, resolveOwnBase } from "./changes";

const HEAD = "c".repeat(40);
const MAIN_HEAD = "d".repeat(40);
const TRUNK = "e".repeat(40);
const MAIN = "/repo";
const LINKED = "/repo/.claude/worktrees/w1";
const NOT_A_REPO = {
  code: 128,
  stderr: "fatal: not a git repository",
};

const A_BEFORE = "export const a = 1;\n";
const A_AFTER = "export const a = 2;\n";
const A_TEST_BEFORE = 'test("a", () => { expect(a).toBe(1); });\n';
const A_TEST_AFTER = 'test("a", () => { expect(a).toBe(3); });\n';

/** `git diff` for a one-line file whose line changed. */
const oneLineDiff = (path: string, before: string, after: string) =>
  [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    `-${before.trimEnd()}`,
    `+${after.trimEnd()}`,
    "",
  ].join("\n");

/** `git worktree list --porcelain` for a main worktree with one linked to it. */
const WORKTREES = `worktree ${MAIN}\nHEAD ${MAIN_HEAD}\nbranch refs/heads/main\n\nworktree ${LINKED}\nHEAD ${HEAD}\nbranch refs/heads/w1\n`;

const { project } = gateSandbox();

describe("resolveBase", () => {
  test("main worktree → HEAD", async () => {
    const run = cannedGit({
      "worktree list --porcelain": `worktree ${MAIN}\nHEAD ${HEAD}\n`,
      "rev-parse HEAD": `${HEAD}\n`,
    });
    expect(await resolveBase(run, MAIN)).toBe(HEAD);
  });

  test("linked worktree → merge-base with main HEAD", async () => {
    const run = cannedGit({
      "worktree list --porcelain": WORKTREES,
      [`${LINKED}$ rev-parse HEAD`]: `${HEAD}\n`,
      [`${MAIN}$ rev-parse HEAD`]: `${MAIN_HEAD}\n`,
      [`merge-base HEAD ${MAIN_HEAD}`]: `${TASK_BASE}\n`,
    });
    expect(await resolveBase(run, LINKED)).toBe(TASK_BASE);
  });

  test("not a repo → null", async () => {
    const run = cannedGit({
      "worktree list --porcelain": NOT_A_REPO,
      "rev-parse HEAD": NOT_A_REPO,
    });
    expect(await resolveBase(run, "/elsewhere")).toBeNull();
  });
});

describe("resolveOwnBase", () => {
  const INTEGRATION = "/repo";
  const WORKER = "/repo/.claude/worktrees/agent-1";

  test("the commit the worker's HEAD shares with the integration worktree's HEAD", async () => {
    const run = cannedGit({
      [`${INTEGRATION}$ rev-parse HEAD`]: `${MAIN_HEAD}\n`,
      [`${WORKER}$ merge-base HEAD ${MAIN_HEAD}`]: `${TASK_BASE}\n`,
    });
    expect(await resolveOwnBase(run, WORKER, INTEGRATION)).toBe(TASK_BASE);
  });

  test("an integration worktree whose HEAD cannot be read is an error naming it", async () => {
    const run = cannedGit({
      [`${INTEGRATION}$ rev-parse HEAD`]: NOT_A_REPO,
    });
    await expect(resolveOwnBase(run, WORKER, INTEGRATION)).rejects.toThrow(
      INTEGRATION,
    );
  });

  test("a worker that shares no commit with the integration worktree is an error", async () => {
    const run = cannedGit({
      [`${INTEGRATION}$ rev-parse HEAD`]: `${MAIN_HEAD}\n`,
      [`${WORKER}$ merge-base HEAD ${MAIN_HEAD}`]: { code: 1 },
    });
    await expect(resolveOwnBase(run, WORKER, INTEGRATION)).rejects.toThrow(
      "shares no commit",
    );
  });
});

describe("collectChanges", () => {
  test("an explicit task base lists what changed since it and asks nothing about the branch before it", async () => {
    const root = await project({
      "src/a.ts": A_AFTER,
      "src/a.test.ts": A_TEST_AFTER,
    });
    // No trunk question is canned: asking one would throw.
    const run = cannedGit({
      [`cat-file -e ${TASK_BASE}^{commit}`]: "",
      [`merge-base --is-ancestor ${TASK_BASE} HEAD`]: "",
      [`diff --name-status -M ${TASK_BASE}`]: "M\tsrc/a.test.ts\nM\tsrc/a.ts\n",
      "ls-files --others --exclude-standard": "",
      [`show ${TASK_BASE}:src/a.ts`]: A_BEFORE,
      [`show ${TASK_BASE}:src/a.test.ts`]: A_TEST_BEFORE,
      [`diff ${TASK_BASE} -- src/a.ts`]: oneLineDiff(
        "src/a.ts",
        A_BEFORE,
        A_AFTER,
      ),
      [`diff ${TASK_BASE} -- src/a.test.ts`]: oneLineDiff(
        "src/a.test.ts",
        A_TEST_BEFORE,
        A_TEST_AFTER,
      ),
    });

    const changes = await collectChanges(run, root, TASK_BASE);
    expect(changes?.base).toBe(TASK_BASE);
    expect(changes?.files.map((f) => f.path)).toEqual([
      "src/a.test.ts",
      "src/a.ts",
    ]);
    expect(changes?.branchPaths).toEqual([]);
  });

  test("an explicit base that is not a full commit id is refused before git is asked", async () => {
    await expect(
      collectChanges(cannedGit({}), "/repo", "HEAD"),
    ).rejects.toThrow("Invalid task base");
  });

  test("an explicit base git does not know is refused", async () => {
    const run = cannedGit({
      [`cat-file -e ${TASK_BASE}^{commit}`]: {
        code: 128,
        stderr: "fatal: Not a valid object name",
      },
    });
    await expect(collectChanges(run, "/repo", TASK_BASE)).rejects.toThrow(
      "Not a valid object name",
    );
  });

  test("an explicit base that is not an ancestor of HEAD is refused", async () => {
    const run = cannedGit({
      [`cat-file -e ${TASK_BASE}^{commit}`]: "",
      [`merge-base --is-ancestor ${TASK_BASE} HEAD`]: { code: 1 },
    });
    await expect(collectChanges(run, "/repo", TASK_BASE)).rejects.toThrow(
      "not a verified ancestor of HEAD",
    );
  });

  test("a failed diff against an explicit base is an error, not an empty change set", async () => {
    const run = cannedGit({
      [`cat-file -e ${TASK_BASE}^{commit}`]: "",
      [`merge-base --is-ancestor ${TASK_BASE} HEAD`]: "",
      [`diff --name-status -M ${TASK_BASE}`]: {
        code: 1,
        stderr: "diff unavailable",
      },
    });
    await expect(collectChanges(run, "/repo", TASK_BASE)).rejects.toThrow(
      "diff unavailable",
    );
  });

  test("with no explicit base, edits, untracked files and deletions are read against the resolved base", async () => {
    const root = await project({
      "src/a.ts": A_AFTER,
      "src/c.ts": "export const c = 3;\n",
    });
    const run = cannedGit({
      "worktree list --porcelain": `worktree ${root}\nHEAD ${HEAD}\n`,
      "rev-parse HEAD": `${HEAD}\n`,
      [`diff --name-status -M ${HEAD}`]: "M\tsrc/a.ts\nD\tsrc/a.test.ts\n",
      "ls-files --others --exclude-standard": "src/c.ts\n",
      [`show ${HEAD}:src/a.ts`]: A_BEFORE,
      [`show ${HEAD}:src/a.test.ts`]: A_TEST_BEFORE,
      [`diff ${HEAD} -- src/a.ts`]: oneLineDiff("src/a.ts", A_BEFORE, A_AFTER),
      [`diff ${HEAD} -- src/a.test.ts`]: "",
      [`merge-base ${HEAD} main`]: `${HEAD}\n`,
    });

    const changes = await collectChanges(run, root);
    expect(changes?.base).toBe(HEAD);
    const byPath = new Map(changes?.files.map((f) => [f.path, f]));

    const a = byPath.get("src/a.ts");
    expect(a?.status).toBe("M");
    expect(a?.added).toBe("export const a = 2;");
    expect(a?.removed).toBe("export const a = 1;");
    expect(a?.before).toBe(A_BEFORE);
    expect(a?.after).toBe(A_AFTER);

    const c = byPath.get("src/c.ts");
    expect(c?.status).toBe("A");
    expect(c?.before).toBeNull();
    expect(c?.added).toBe("export const c = 3;\n");

    const t = byPath.get("src/a.test.ts");
    expect(t?.status).toBe("D");
    expect(t?.after).toBeNull();
  });

  test("clean worktree → empty change set", async () => {
    const root = await project({});
    const run = cannedGit({
      "worktree list --porcelain": `worktree ${root}\nHEAD ${HEAD}\n`,
      "rev-parse HEAD": `${HEAD}\n`,
      [`diff --name-status -M ${HEAD}`]: "",
      "ls-files --others --exclude-standard": "",
      [`merge-base ${HEAD} main`]: `${HEAD}\n`,
    });
    expect((await collectChanges(run, root))?.files).toEqual([]);
  });
});

describe("collectChanges branchPaths", () => {
  /** A worker's one source edit, with whatever the test says about trunk. */
  const sourceEdit = async (
    trunk: Record<string, string | { code: number }>,
  ) => {
    const root = await project({ "src/a.ts": A_AFTER });
    const run = cannedGit({
      "worktree list --porcelain": `worktree ${root}\nHEAD ${HEAD}\n`,
      "rev-parse HEAD": `${HEAD}\n`,
      [`diff --name-status -M ${HEAD}`]: "M\tsrc/a.ts\n",
      "ls-files --others --exclude-standard": "",
      [`show ${HEAD}:src/a.ts`]: A_BEFORE,
      [`diff ${HEAD} -- src/a.ts`]: oneLineDiff("src/a.ts", A_BEFORE, A_AFTER),
      ...trunk,
    });
    return collectChanges(run, root);
  };

  test("files the branch committed between trunk and the base", async () => {
    const changes = await sourceEdit({
      [`merge-base ${HEAD} main`]: `${TRUNK}\n`,
      [`diff --name-only ${TRUNK} ${HEAD}`]: "src/a.test.ts\n",
    });
    expect(changes?.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(changes?.branchPaths).toEqual(["src/a.test.ts"]);
  });

  test("empty when the base sits on trunk", async () => {
    // The name-only diff is not canned: asking for it would throw.
    const changes = await sourceEdit({
      [`merge-base ${HEAD} main`]: `${HEAD}\n`,
    });
    expect(changes?.branchPaths).toEqual([]);
  });

  test("empty when the repo has no trunk branch at all", async () => {
    const changes = await sourceEdit({
      [`merge-base ${HEAD} main`]: { code: 128 },
      [`merge-base ${HEAD} master`]: { code: 128 },
    });
    expect(changes?.branchPaths).toEqual([]);
  });
});
