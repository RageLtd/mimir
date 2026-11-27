/**
 * The skill-before-edit rule on Claude Code: `mimir-cc guard` remembers each
 * `Skill` call for the loop that made it, and refuses an edit whose skill
 * that loop has not loaded. The guard is handed the payload's text and a
 * canned git, so no command runs; the rule itself is held in plugin-core.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  editSkillDecision,
  readLoadedSkills,
  writeCoordinatorState,
} from "@mimir/plugin-core/guard";
import { cannedGit } from "@mimir/plugin-core/verify/testing";
import { delegateSandbox, HEAD } from "./delegate-sandbox";
import { answerGuard } from "./guard-hook";

const SESSION = "sess-guard-edit-skills";
const GENERAL = { agent_id: "general-1", agent_type: "general-purpose" };
const OTHER_GENERAL = { agent_id: "general-2", agent_type: "general-purpose" };
const COORDINATOR_REFUSAL = "the coordinator delegates, it does not implement";

const { repo } = delegateSandbox(SESSION);

/** Git as the guard asks it: the project directory is its own top level. */
const deps = () => ({
  run: cannedGit({
    "rev-parse --show-toplevel": `${repo()}\n`,
    "worktree list --porcelain": `worktree ${repo()}\n`,
  }),
});

/** A PreToolUse payload from the main loop, or from the loop `agent` names. */
const call = (
  tool_name: string,
  tool_input: Record<string, unknown>,
  agent: { agent_id?: string; agent_type?: string } = {},
) =>
  JSON.stringify({
    session_id: SESSION,
    hook_event_name: "PreToolUse",
    cwd: repo(),
    tool_name,
    tool_input,
    ...agent,
  });

const loadSkill = (skill: string, agent?: { agent_id?: string }) =>
  answerGuard(call("Skill", { skill }, agent), deps());

const edit = (
  path: string,
  agent?: { agent_id?: string; agent_type?: string },
) =>
  answerGuard(
    call("Edit", { file_path: path, old_string: "0", new_string: "1" }, agent),
    deps(),
  );

const reasonOf = (answer: Awaited<ReturnType<typeof answerGuard>>) =>
  answer?.hookSpecificOutput.permissionDecisionReason;

const sourceFile = () => join(repo(), "src", "value.ts");
const testFile = () => join(repo(), "src", "value.test.ts");

/** What the rule says when the edit's skill is missing. */
const ruleRefusal = (path: string) => {
  const decision = editSkillDecision(path, []);
  return decision.allow ? "" : decision.reason;
};

describe("a Skill call", () => {
  test("is allowed", async () => {
    expect(await loadSkill("mimir-cc:code-comments")).toBeNull();
  });

  test("is recorded for the loop that made it", async () => {
    await loadSkill("mimir-cc:unit-testing");
    await loadSkill("code-comments", GENERAL);

    expect(await readLoadedSkills({ sessionId: SESSION })).toEqual([
      "mimir-cc:unit-testing",
    ]);
    expect(
      await readLoadedSkills({ sessionId: SESSION, agentId: GENERAL.agent_id }),
    ).toEqual(["code-comments"]);
  });
});

describe("the main loop with no delegation active", () => {
  // The guard treats these as the tools that write a file by path.
  test.each([
    ["Edit", { old_string: "0", new_string: "1" }],
    ["Write", { content: "export const value = 1;\n" }],
    ["MultiEdit", { edits: [{ old_string: "0", new_string: "1" }] }],
  ])("%s of a source file is refused with the rule's message until code-comments is loaded", async (tool, input) => {
    const path = sourceFile();
    const write = () =>
      answerGuard(call(tool, { file_path: path, ...input }), deps());

    const before = await write();
    expect(before?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(reasonOf(before)).toBe(ruleRefusal(path));

    await loadSkill("mimir-cc:code-comments");
    expect(await write()).toBeNull();
  });

  test.each([
    ["Edit", { old_string: "0", new_string: "1" }],
    ["Write", { content: "test('v', () => {});\n" }],
    ["MultiEdit", { edits: [{ old_string: "0", new_string: "1" }] }],
  ])("%s of a test file is refused with the rule's message until unit-testing is loaded", async (tool, input) => {
    const path = testFile();
    const write = () =>
      answerGuard(call(tool, { file_path: path, ...input }), deps());

    const before = await write();
    expect(before?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(reasonOf(before)).toBe(ruleRefusal(path));

    await loadSkill("mimir-cc:unit-testing");
    expect(await write()).toBeNull();
  });

  test("a skill loaded by its bare name counts", async () => {
    await loadSkill("code-comments");
    expect(await edit(sourceFile())).toBeNull();
  });

  test("unit-testing does not let a source file through", async () => {
    await loadSkill("mimir-cc:unit-testing");
    expect(reasonOf(await edit(sourceFile()))).toBe(ruleRefusal(sourceFile()));
  });

  test.each([
    "README.md",
    "package.json",
  ])("an edit to %s needs no skill", async (name) => {
    expect(await edit(join(repo(), name))).toBeNull();
  });
});

describe("each loop keeps its own skills", () => {
  test("a skill the main loop loaded does not let a subagent's edit through", async () => {
    await loadSkill("mimir-cc:code-comments");

    expect(reasonOf(await edit(sourceFile(), GENERAL))).toBe(
      ruleRefusal(sourceFile()),
    );
  });

  test("a skill a subagent loaded does not let the main loop's edit through", async () => {
    await loadSkill("mimir-cc:code-comments", GENERAL);

    expect(await edit(sourceFile(), GENERAL)).toBeNull();
    expect(reasonOf(await edit(sourceFile()))).toBe(ruleRefusal(sourceFile()));
  });

  test("a skill one subagent loaded does not let another's edit through", async () => {
    await loadSkill("mimir-cc:unit-testing", GENERAL);

    expect(reasonOf(await edit(testFile(), OTHER_GENERAL))).toBe(
      ruleRefusal(testFile()),
    );
  });

  test("a subagent that is not one of Mimir's workers is held to the rule", async () => {
    expect(reasonOf(await edit(testFile(), GENERAL))).toBe(
      ruleRefusal(testFile()),
    );
    await loadSkill("mimir-cc:unit-testing", GENERAL);
    expect(await edit(testFile(), GENERAL)).toBeNull();
  });
});

describe("Mimir's workers", () => {
  const IMPL = { agent_id: "impl-1", agent_type: "mimir-cc:mimir-impl" };
  const TEST = { agent_id: "test-1", agent_type: "mimir-cc:mimir-test" };
  const REVIEW = { agent_id: "review-1", agent_type: "mimir-cc:mimir-review" };

  test("an impl worker edits a source file without loading code-comments", async () => {
    expect(await edit(sourceFile(), IMPL)).toBeNull();
  });

  test("a test worker edits a test file without loading unit-testing", async () => {
    expect(await edit(testFile(), TEST)).toBeNull();
  });

  test("a worker's role rules still refuse, with their own message", async () => {
    expect(reasonOf(await edit(testFile(), IMPL))).toContain(
      "mimir-impl may not modify test files",
    );
    expect(reasonOf(await edit(sourceFile(), TEST))).toContain(
      "mimir-test may only modify test files",
    );
    expect(reasonOf(await edit(sourceFile(), REVIEW))).toContain(
      "mimir-review is read-only",
    );
  });
});

describe("Mimir's workers in a task marked as a refactor", () => {
  const IMPL = { agent_id: "impl-1", agent_type: "mimir-cc:mimir-impl" };
  const TEST = { agent_id: "test-1", agent_type: "mimir-cc:mimir-test" };
  const REVIEW = { agent_id: "review-1", agent_type: "mimir-cc:mimir-review" };

  const startTask = async (refactor: boolean) => {
    const planFile = join(repo(), "plan.md");
    await Bun.write(planFile, "# plan\n");
    await writeCoordinatorState(SESSION, {
      active: true,
      planFile,
      task: { base: HEAD, worktree: repo(), refactor },
    });
  };

  test("an impl worker's edit to a source file is refused until it loads refactor", async () => {
    await startTask(true);

    const before = await edit(sourceFile(), IMPL);
    expect(before?.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(reasonOf(before)).toContain("refactor");
    expect(reasonOf(before)).toMatch(/\bload\b/i);
    expect(reasonOf(before)).toMatch(/\bretry\b/i);

    await loadSkill("mimir-cc:refactor", IMPL);
    expect(await edit(sourceFile(), IMPL)).toBeNull();
  });

  test("the impl worker is not asked for code-comments, which is preloaded", async () => {
    await startTask(true);
    expect(reasonOf(await edit(sourceFile(), IMPL))).not.toContain(
      "code-comments",
    );
  });

  test("refactor loaded by another loop does not let the impl worker through", async () => {
    await startTask(true);
    await loadSkill("mimir-cc:refactor");
    expect(reasonOf(await edit(sourceFile(), IMPL))).toContain("refactor");
  });

  test("in a task not marked as a refactor the impl worker edits a source file with nothing loaded", async () => {
    await startTask(false);
    expect(await edit(sourceFile(), IMPL)).toBeNull();
  });

  test("the test worker edits a test file with nothing loaded", async () => {
    await startTask(true);
    expect(await edit(testFile(), TEST)).toBeNull();
  });

  test("role rules still refuse first, with their own message", async () => {
    await startTask(true);
    expect(reasonOf(await edit(testFile(), IMPL))).toContain(
      "mimir-impl may not modify test files",
    );
    expect(reasonOf(await edit(sourceFile(), TEST))).toContain(
      "mimir-test may only modify test files",
    );
    expect(reasonOf(await edit(sourceFile(), REVIEW))).toContain(
      "mimir-review is read-only",
    );
    await loadSkill("mimir-cc:refactor", REVIEW);
    expect(reasonOf(await edit(sourceFile(), REVIEW))).toContain(
      "mimir-review is read-only",
    );
  });
});

describe("the coordinator in an active delegation", () => {
  let planFile: string;

  beforeEach(async () => {
    planFile = join(repo(), "plan.md");
    await Bun.write(planFile, "# plan\n");
    await writeCoordinatorState(SESSION, { active: true, planFile });
  });

  test("editing a source file is refused as the coordinator's, not as a missing skill", async () => {
    const reason = reasonOf(await edit(sourceFile()));
    expect(reason).toContain(COORDINATOR_REFUSAL);
    expect(reason).not.toBe(ruleRefusal(sourceFile()));
  });

  test("editing a source file stays refused once code-comments is loaded", async () => {
    await loadSkill("mimir-cc:code-comments");
    expect(reasonOf(await edit(sourceFile()))).toContain(COORDINATOR_REFUSAL);
  });

  test("its plan file is edited without loading a skill", async () => {
    expect(await edit(planFile)).toBeNull();
  });
});

describe("calls that are neither an edit nor a Skill call", () => {
  test.each([
    ["Read", { file_path: "src/value.ts" }],
    ["Bash", { command: "echo hello" }],
    ["Grep", { pattern: "value" }],
  ])("%s from the main loop is allowed without any skill", async (tool, input) => {
    expect(await answerGuard(call(tool, input), deps())).toBeNull();
  });

  test.each([
    ["Read", { file_path: "src/value.ts" }],
    ["Bash", { command: "echo hello" }],
  ])("%s from a subagent is allowed without any skill", async (tool, input) => {
    expect(await answerGuard(call(tool, input, GENERAL), deps())).toBeNull();
  });
});
