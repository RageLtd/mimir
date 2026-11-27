import { describe, expect, test } from "bun:test";
import { WORKER_HOSTS, type WorkerHost } from "../shared-config";
import { DELEGATE_POLICY, renderDelegateCommand } from "./delegate-command";

const DESCRIPTION =
  "Run a change through the autonomous-worker loop — the default for any non-trivial change a test can hold (new behaviour, a reproducible bug, a refactor with a contract). Plan, red test (mimir-test), green implementation (mimir-impl), cold review (mimir-review), verify gate on every hand-back; hands the developer a branch. Not for one-line fixes, config or docs edits, or investigation.";
const ARGUMENT_HINT =
  'argument-hint: "<task description or path to a plan file>"';
const ARGUMENTS_TAIL = "\n\n$ARGUMENTS\n";

const rendered = (host: WorkerHost) => renderDelegateCommand(host);

const frontmatterOf = (md: string) => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(md);
  const block = match?.[1];
  if (block === undefined) throw new Error("no frontmatter block");
  return block;
};

/**
 * One phrase per policy topic. Each must sit inside a shared policy
 * passage, so it reads the same on every host.
 */
const POLICY_ANCHORS = {
  trustBoundary: [
    "the gate decides *done*, you decide *next*, the developer decides *merge*",
    "You produce a branch, never a merge to main.",
  ],
  planFile: [
    ".mimir/plans/<slug>.md",
    "Context is a cache of this file",
    'If you find yourself wanting to "just fix it quickly", write a task instead.',
  ],
  writingBriefs: [
    "## Writing tasks and briefs",
    "Say what must be true, not what the code looks like.",
    "Preserve behaviour, never files.",
    "Size a task to one worker run.",
    "Tell the test worker what its gate leaves unchecked.",
  ],
  workerBriefs: [
    "the behaviour to test (what must be true, not the interface that makes it so), where the tests belong",
    "write the test red-first; do not touch implementation",
    "the failing test(s) by name, the files in scope, and nothing about *how*",
    "Never accept a `done` without that report. Read the added tests before accepting.",
    "You write nothing but the title.",
  ],
  findingIsAClaim: [
    "A finding is a claim, not a fact",
    "drop what cannot happen in the project as it runs",
    "Nits you note in the plan file.",
  ],
  refactorTask: [
    "**A refactor has no red test.**",
    "blocks instead if any test changed since the task began",
    "run it as a normal task with a test worker",
  ],
  roleBoundary: [
    "**A failure in the other role's files**",
    "only if its own change cannot clear the failure",
    "run the other role for the files the gate named",
  ],
  assertionsRemoved: [
    "**Assertions removed**",
    "assertions moved into a shared helper read as removed",
    "it excuses only the loss",
    "never allow a file you have not read",
  ],
  conventionalCommits: [
    "the release pipeline versions from them",
    "— review follow-up",
  ],
  escalate: ["**Escalate** means", "tell the developer what you need decided"],
  finishing: [
    "Store **one** curated project memory for the whole delegation",
    "Workers persist nothing; you persist once.",
    "the branch's many small commits are an audit trail, not a changelog",
    "Do not push, do not open a PR unless asked.",
  ],
  neverDo: [
    "## What you never do",
    "Accept `done` without the gate report.",
    "Write a review prompt beyond the title.",
    "Respawn a failed worker with the same prompt.",
  ],
};

/** Tokens that only make sense on one host. */
const CLAUDE_CODE_ONLY = [
  "mimir-cc",
  "git worktree",
  "SendMessage",
  "worktreePath",
];
const OPENCODE_ONLY = ["mimir_delegate", "mimir_review_prompt", "task_id"];

const MECHANICS: Record<WorkerHost, readonly string[]> = {
  claudeCode: [
    // stale-worktree check
    "git worktree list",
    "git worktree remove <path>",
    // coordinator lifecycle
    "mimir-cc delegate start --plan",
    "mimir-cc delegate task",
    "mimir-cc delegate task --refactor",
    "mimir-cc delegate allow-deletion <path>...",
    "mimir-cc delegate allow-removal <path>...",
    "mimir-cc delegate stop",
    "keyed by session id",
    // one worktree per worker
    "in its own worktree",
    // per-role models
    "worker models:",
    "`model` parameter",
    // resuming
    "SendMessage",
    "A worker that died",
    "Stale base",
    "git -C <worktreePath> merge <integration-branch>",
    "mimir-cc verify --worktree <worktreePath> --agent <agentId>",
    // collecting
    "git merge --no-ff <worktreeBranch>",
    "git branch -d <worktreeBranch>",
    "`-d`, never `-D`",
    "mimir-cc verify --worktree <repo root> --allow-empty",
    "This run judges the whole task from its base",
    // review: the reviewer starts in its own worktree, and the git guard
    // refuses a `cd` into the one under review
    "mimir-cc review-prompt <worktreePath>",
    "you do not need to `cd` into it",
    "by their paths under `<worktreePath>`",
  ],
  opencode: [
    "`mimir_delegate`",
    'action: "start"',
    'action: "task"',
    'action: "stop"',
    "`refactor: true`",
    'action: "allow-deletion"',
    'action: "allow-removal"',
    "every gate run judges the whole task from its base",
    "strictly one at a time",
    "every worker runs in **this** directory",
    "commit each accepted result before spawning the next",
    "baked into the agent files at install time",
    "`task_id`",
    "mimir_review_prompt",
  ],
};

const LEAKS: Record<WorkerHost, readonly string[]> = {
  claudeCode: OPENCODE_ONLY,
  opencode: CLAUDE_CODE_ONLY,
};

describe("DELEGATE_POLICY", () => {
  test("is a list of non-empty passages", () => {
    expect(DELEGATE_POLICY.length).toBeGreaterThan(0);
    for (const passage of DELEGATE_POLICY) {
      expect(passage.trim().length).toBeGreaterThan(0);
    }
  });

  test("every policy topic is carried by a shared passage", () => {
    for (const [topic, anchors] of Object.entries(POLICY_ANCHORS)) {
      for (const anchor of anchors) {
        const home = DELEGATE_POLICY.find((p) => p.includes(anchor));
        expect({ topic, anchor, inPolicy: home !== undefined }).toEqual({
          topic,
          anchor,
          inPolicy: true,
        });
      }
    }
  });

  test("names no host mechanics", () => {
    for (const passage of DELEGATE_POLICY) {
      for (const token of [...CLAUDE_CODE_ONLY, ...OPENCODE_ONLY]) {
        expect({ token, passage, leaks: passage.includes(token) }).toEqual({
          token,
          passage,
          leaks: false,
        });
      }
    }
  });
});

describe("renderDelegateCommand", () => {
  for (const host of WORKER_HOSTS) {
    test(`${host}: carries every policy passage verbatim, in order`, () => {
      const md = rendered(host);
      let cursor = -1;
      for (const passage of DELEGATE_POLICY) {
        const at = md.indexOf(passage, cursor + 1);
        expect({ passage, found: at > cursor }).toEqual({
          passage,
          found: true,
        });
        cursor = at;
      }
    });

    test(`${host}: carries its own mechanics`, () => {
      const md = rendered(host);
      for (const mechanic of MECHANICS[host]) {
        expect(md).toContain(mechanic);
      }
    });

    test(`${host}: does not leak the other host's mechanics`, () => {
      const md = rendered(host);
      for (const token of LEAKS[host]) {
        expect(md).not.toContain(token);
      }
    });

    test(`${host}: keeps its description and passes the arguments through`, () => {
      const md = rendered(host);
      expect(frontmatterOf(md)).toContain(`description: ${DESCRIPTION}`);
      expect(md.endsWith(ARGUMENTS_TAIL)).toBe(true);
    });
  }

  test("Claude Code keeps its argument hint; OpenCode has none", () => {
    expect(frontmatterOf(rendered("claudeCode"))).toContain(ARGUMENT_HINT);
    expect(frontmatterOf(rendered("opencode"))).not.toContain("argument-hint");
  });

  test("policy is word-for-word the same across hosts", () => {
    const claude = rendered("claudeCode");
    const opencode = rendered("opencode");
    for (const anchors of Object.values(POLICY_ANCHORS)) {
      for (const anchor of anchors) {
        expect({ anchor, claude: claude.includes(anchor) }).toEqual({
          anchor,
          claude: true,
        });
        expect({ anchor, opencode: opencode.includes(anchor) }).toEqual({
          anchor,
          opencode: true,
        });
      }
    }
  });

  test("the shorter wordings from the old OpenCode file are gone", () => {
    for (const host of WORKER_HOSTS) {
      const md = rendered(host);
      expect(md).not.toContain("(`feat(<scope>): …`). Do not push");
      expect(md).not.toContain("Write a review prompt. ");
    }
  });
});
