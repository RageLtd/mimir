/**
 * `mimir-cc review-prompt <worktree>` — the cold reviewer's prompt for a
 * task: which change set it asks for, what it leaves out, and when it
 * refuses. The change set is handed in and git is canned.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeCoordinatorState } from "@mimir/plugin-core/guard";
import type { ChangedFile, ChangeSource } from "@mimir/plugin-core/verify";
import {
  cannedGit,
  changed,
  changeSet,
} from "@mimir/plugin-core/verify/testing";
import { runReviewPromptCommand, SESSION_ENV } from "./delegate-command";
import { captured, delegateSandbox, HEAD } from "./delegate-sandbox";

const SESSION = "sess-review-prompt";
const WORKER = "impl-worker";
const PLAN_TEXT = "private plan rationale\n";

const SPEC_CHANGE = changed(
  "value.spec.ts",
  'test("value", () => expect(value).toBe(0));\n',
  'test("value", () => expect(value).toBe(1));\n',
);
const SOURCE_CHANGE = changed(
  "value.ts",
  "export const value = 0;\n",
  "export const value = 1;\n",
);
/** The worker's worktree carries its own copy of the active plan. */
const PLAN_COPY = changed("plan.md", null, PLAN_TEXT);

/** A change source that records what it was asked and answers `files`. */
const recordingChanges = (files: readonly ChangedFile[]) => {
  const asked: (readonly [string, string | undefined])[] = [];
  const changes: ChangeSource = {
    collect: async (worktree, base) => {
      asked.push([worktree, base]);
      return changeSet(files, { base });
    },
    ownBase: async () => HEAD,
  };
  return { asked, changes };
};

describe("review-prompt", () => {
  const { addWorker, repo, worktreeGit } = delegateSandbox(SESSION);

  beforeEach(async () => {
    const planFile = join(repo(), "plan.md");
    await Bun.write(planFile, PLAN_TEXT);
    await writeCoordinatorState(SESSION, {
      active: true,
      planFile,
      task: { base: HEAD, worktree: repo() },
    });
  });

  test("shows the task's test and change, read from the worker's worktree at the task base, and leaves the plan out", async () => {
    const worker = addWorker(WORKER);
    const source = recordingChanges([SPEC_CHANGE, SOURCE_CHANGE, PLAN_COPY]);

    const review = await captured(() =>
      runReviewPromptCommand([worker], worktreeGit(worker), source.changes),
    );
    expect(review.code, review.stderr).toBe(0);
    expect(review.stdout).toContain("value.spec.ts");
    expect(review.stdout).toContain("export const value = 1;");
    expect(review.stdout).not.toContain("private plan rationale");
    expect(source.asked).toEqual([[worker, HEAD]]);
  });

  test("a directory nested in the worktree is reviewed at the worktree's top level", async () => {
    const worker = addWorker(WORKER);
    const nested = join(worker, "nested", "directory");
    const source = recordingChanges([SPEC_CHANGE, SOURCE_CHANGE]);

    const review = await captured(() =>
      runReviewPromptCommand(
        [nested],
        worktreeGit(worker, {
          [`${nested}$ rev-parse --git-common-dir`]: `${join(repo(), ".git")}\n`,
          [`${nested}$ rev-parse --show-toplevel`]: `${worker}\n`,
        }),
        source.changes,
      ),
    );
    expect(review.code, review.stderr).toBe(0);
    expect(source.asked).toEqual([[worker, HEAD]]);
  });

  test("without the session it refuses, instead of reviewing a change set it cannot place", async () => {
    delete process.env[SESSION_ENV];
    const source = recordingChanges([SOURCE_CHANGE]);

    const review = await captured(() =>
      runReviewPromptCommand([repo()], cannedGit({}), source.changes),
    );
    expect(review.code).toBe(1);
    expect(review.stderr).toContain("CLAUDE_CODE_SESSION_ID");
    expect(review.stdout).not.toContain("value.ts");
    expect(source.asked).toEqual([]);
  });

  test("a worktree whose HEAD does not descend from the task base is refused, not reviewed", async () => {
    const worker = addWorker(WORKER);
    const source = recordingChanges([SOURCE_CHANGE]);

    const review = await captured(() =>
      runReviewPromptCommand(
        [worker],
        worktreeGit(worker, {
          [`${worker}$ merge-base --is-ancestor ${HEAD} HEAD`]: { code: 1 },
        }),
        source.changes,
      ),
    );
    expect(review.code).not.toBe(0);
    expect(review.stderr).toContain("Cannot validate task repository");
    expect(source.asked).toEqual([]);
  });

  test("a change set holding nothing but the plan is nothing to review", async () => {
    const worker = addWorker(WORKER);
    const source = recordingChanges([PLAN_COPY]);

    const review = await captured(() =>
      runReviewPromptCommand([worker], worktreeGit(worker), source.changes),
    );
    expect(review.code).toBe(1);
    expect(review.stderr).toContain("no changes");
  });
});
