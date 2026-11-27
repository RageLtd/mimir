import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editSkillDecision,
  writeCoordinatorState,
} from "@mimir/plugin-core/guard";
import { enforceEditSkill } from "./edit-skill-guard";
import { normalizeToolCalls } from "./tool-map";
import {
  createSessionRoles,
  enforceRoleGuard,
  type SessionInfo,
} from "./worker-hooks";

const ROOT = "/work/repo";
const SOURCE = "src/a.ts";
const TEST = "src/a.test.ts";
const MAIN = "main";
const TEST_WORKER = "test-worker";
const IMPL_WORKER = "impl-worker";

const dirs: string[] = [];
const savedHome = process.env.MIMIR_HOME;
let home = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mimir-oc-edit-skill-"));
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

const sessions: Record<string, SessionInfo> = {
  [MAIN]: {},
  other: {},
  [TEST_WORKER]: { parentID: MAIN, agent: "mimir-test" },
  [IMPL_WORKER]: { parentID: MAIN, agent: "mimir-impl" },
};

/**
 * One tool call through `execute.before` as the hook arranges it: the
 * call normalised into file calls, the role guard over every one of them,
 * then the edit-skill rule over every one of them.
 */
const beforeTool = async (sessionID: string, tool: string, input: unknown) => {
  const roles = createSessionRoles(async (id) => sessions[id] ?? null);
  const calls = normalizeToolCalls(tool, input, ROOT);
  for (const call of calls) {
    await enforceRoleGuard(
      roles,
      { tool: call.toolName, sessionID },
      {
        ...call.toolInput,
        filePath: call.toolInput.file_path ?? call.toolInput.path,
      },
      ROOT,
    );
  }
  for (const call of calls) await enforceEditSkill(sessionID, call, roles);
};

const loadSkill = (sessionID: string, id: string) =>
  beforeTool(sessionID, "skill", { id });

const edit = (sessionID: string, path: string) =>
  beforeTool(sessionID, "edit", { path, oldString: "a", newString: "b" });

const patch = (...lines: string[]) => ({
  patchText: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n"),
});

/** The shared rule's own refusal for an edit to `path` with `loaded` loaded. */
const ruleReason = (path: string, loaded: readonly string[] = []) => {
  const decision = editSkillDecision(join(ROOT, path), loaded);
  if (decision.allow) throw new Error(`${path} needs no further skill`);
  return decision.reason;
};

const SOURCE_REASON = ruleReason(SOURCE);
const lessCodeReason = () => ruleReason(SOURCE, ["code-comments"]);
const TEST_REASON = ruleReason(TEST);

/** The message an edit was refused with, or "" when it went through. */
const refusalOf = (attempt: Promise<void>) =>
  attempt.then(
    () => "",
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );

/** Both skills a source file needs. */
const loadSourceSkills = async (sessionID: string) => {
  await loadSkill(sessionID, "code-comments");
  await loadSkill(sessionID, "less-code");
};

/** Each OpenCode tool that writes a file, as a call against `path`. */
const writers = (path: string) => ({
  edit: ["edit", { path, oldString: "a", newString: "b" }] as const,
  write: ["write", { path, content: "x\n" }] as const,
  "patch (update)": [
    "patch",
    patch(`*** Update File: ${path}`, "@@", "-a", "+b"),
  ] as const,
  "patch (add)": ["patch", patch(`*** Add File: ${path}`, "+x")] as const,
});

describe("loading a skill", () => {
  test("a skill call is not refused, whoever makes it", async () => {
    for (const session of [MAIN, TEST_WORKER, IMPL_WORKER])
      await loadSkill(session, "unit-testing");
  });

  test("a skill named by the older `name` field counts too", async () => {
    await beforeTool(MAIN, "skill", { name: "code-comments" });
    await beforeTool(MAIN, "skill", { name: "less-code" });
    await edit(MAIN, SOURCE);
  });

  test("a plugin-qualified skill counts too", async () => {
    await loadSkill(MAIN, "mimir-cc:code-comments");
    await loadSkill(MAIN, "mimir-cc:less-code");
    await edit(MAIN, SOURCE);
  });
});

describe("an edit needs its skill loaded", () => {
  for (const [label, [tool, input]] of Object.entries(writers(SOURCE))) {
    test(`${label} on a source file is refused until code-comments and less-code are loaded`, async () => {
      await expect(beforeTool(MAIN, tool, input)).rejects.toThrow(
        SOURCE_REASON,
      );
      await loadSkill(MAIN, "unit-testing");
      await expect(beforeTool(MAIN, tool, input)).rejects.toThrow(
        SOURCE_REASON,
      );
      await loadSkill(MAIN, "code-comments");
      const reason = lessCodeReason();
      await expect(beforeTool(MAIN, tool, input)).rejects.toThrow(reason);
      await loadSkill(MAIN, "less-code");
      await beforeTool(MAIN, tool, input);
    });
  }

  test("one refusal names both missing skills, and loading them lets the retried edit through", async () => {
    const refused = await refusalOf(edit(MAIN, SOURCE));
    expect(refused).toContain("code-comments");
    expect(refused).toContain("less-code");
    expect(refused).toMatch(/\bload\b/i);
    expect(refused).toMatch(/\bretry\b/i);

    await loadSkill(MAIN, "code-comments");
    await loadSkill(MAIN, "less-code");
    await edit(MAIN, SOURCE);
  });

  test("with code-comments loaded the refusal names only less-code, says to load it and then retry the edit", async () => {
    await loadSkill(MAIN, "code-comments");
    const refused = await refusalOf(edit(MAIN, SOURCE));
    expect(refused).toContain("less-code");
    expect(refused).not.toContain("code-comments");
    expect(refused).toMatch(/\bload\b/i);
    expect(refused).toMatch(/\bretry\b/i);
  });

  for (const [label, [tool, input]] of Object.entries(writers(TEST))) {
    test(`${label} on a test file is refused until unit-testing is loaded`, async () => {
      await expect(beforeTool(MAIN, tool, input)).rejects.toThrow(TEST_REASON);
      await loadSourceSkills(MAIN);
      await expect(beforeTool(MAIN, tool, input)).rejects.toThrow(TEST_REASON);
      await loadSkill(MAIN, "unit-testing");
      await beforeTool(MAIN, tool, input);
    });
  }

  test("a patch touching a source and a test file needs every skill for both", async () => {
    const input = patch(
      `*** Update File: ${SOURCE}`,
      "@@",
      "-a",
      "+b",
      `*** Add File: ${TEST}`,
      "+x",
    );
    await loadSkill(MAIN, "code-comments");
    await loadSkill(MAIN, "unit-testing");
    const reason = lessCodeReason();
    await expect(beforeTool(MAIN, "patch", input)).rejects.toThrow(reason);
    await loadSkill(MAIN, "less-code");
    await beforeTool(MAIN, "patch", input);
  });

  test("an edit to a file that needs no skill goes through", async () => {
    for (const [tool, input] of Object.values(writers("docs/notes.md")))
      await beforeTool(MAIN, tool, input);
    for (const [tool, input] of Object.values(writers("config.json")))
      await beforeTool(MAIN, tool, input);
  });
});

describe("sessions are separate", () => {
  test("a skill one session loaded does not let another session's edit through", async () => {
    await loadSourceSkills(MAIN);
    await loadSkill(MAIN, "unit-testing");
    await expect(edit("other", SOURCE)).rejects.toThrow(SOURCE_REASON);
    await expect(edit("other", TEST)).rejects.toThrow(TEST_REASON);
    await edit(MAIN, SOURCE);
  });

  test("a parent's skills do not cover its worker", async () => {
    await loadSourceSkills(MAIN);
    await expect(edit(IMPL_WORKER, SOURCE)).rejects.toThrow(SOURCE_REASON);
  });
});

describe("Mimir's workers are held to the rule", () => {
  test("a test worker's edit to a test file waits for unit-testing", async () => {
    await expect(edit(TEST_WORKER, TEST)).rejects.toThrow(TEST_REASON);
    await loadSkill(TEST_WORKER, "unit-testing");
    await edit(TEST_WORKER, TEST);
  });

  test("an implementer's edit to a source file waits for code-comments and less-code", async () => {
    await expect(edit(IMPL_WORKER, SOURCE)).rejects.toThrow(SOURCE_REASON);
    await loadSkill(IMPL_WORKER, "code-comments");
    const reason = lessCodeReason();
    await expect(edit(IMPL_WORKER, SOURCE)).rejects.toThrow(reason);
    await loadSkill(IMPL_WORKER, "less-code");
    await edit(IMPL_WORKER, SOURCE);
  });
});

describe("in a task marked as a refactor", () => {
  /** The coordinator's state with a current task, marked as `refactor` says. */
  const startTask = async (refactor: boolean) => {
    const planFile = join(home, "plan.md");
    await Bun.write(planFile, "# Plan\n");
    await writeCoordinatorState(MAIN, {
      active: true,
      planFile,
      task: { base: "c".repeat(40), worktree: ROOT, refactor },
    });
  };

  test("an implementer's edit to a source file waits for code-comments, less-code and refactor", async () => {
    await startTask(true);
    await expect(edit(IMPL_WORKER, SOURCE)).rejects.toThrow(/code-comments/);
    await loadSkill(IMPL_WORKER, "code-comments");
    await expect(edit(IMPL_WORKER, SOURCE)).rejects.toThrow(/less-code/);
    await loadSkill(IMPL_WORKER, "less-code");
    await expect(edit(IMPL_WORKER, SOURCE)).rejects.toThrow(/refactor/);
    await loadSkill(IMPL_WORKER, "refactor");
    await edit(IMPL_WORKER, SOURCE);
  });

  test("refactor loaded first still leaves code-comments and less-code to load", async () => {
    await startTask(true);
    await loadSkill(IMPL_WORKER, "refactor");
    await expect(edit(IMPL_WORKER, SOURCE)).rejects.toThrow(/code-comments/);
    await loadSkill(IMPL_WORKER, "code-comments");
    await expect(edit(IMPL_WORKER, SOURCE)).rejects.toThrow(/less-code/);
    await loadSkill(IMPL_WORKER, "less-code");
    await edit(IMPL_WORKER, SOURCE);
  });

  test("with code-comments and less-code loaded the refusal names only refactor, says to load it and then retry the edit", async () => {
    await startTask(true);
    await loadSourceSkills(IMPL_WORKER);
    const refused = await refusalOf(edit(IMPL_WORKER, SOURCE));
    expect(refused).toContain("refactor");
    expect(refused).not.toContain("code-comments");
    expect(refused).not.toContain("less-code");
    expect(refused).toMatch(/\bload\b/i);
    expect(refused).toMatch(/\bretry\b/i);
  });

  test("one refusal names all three missing skills, and loading them lets the retried edit through", async () => {
    await startTask(true);
    const refused = await refusalOf(edit(IMPL_WORKER, SOURCE));
    expect(refused).toContain("code-comments");
    expect(refused).toContain("less-code");
    expect(refused).toContain("refactor");

    await loadSkill(IMPL_WORKER, "code-comments");
    await loadSkill(IMPL_WORKER, "less-code");
    await loadSkill(IMPL_WORKER, "refactor");
    await edit(IMPL_WORKER, SOURCE);
  });

  test("with refactor loaded the refusal names code-comments and less-code", async () => {
    await startTask(true);
    await loadSkill(IMPL_WORKER, "refactor");
    const refused = await refusalOf(edit(IMPL_WORKER, SOURCE));
    expect(refused).toContain("code-comments");
    expect(refused).toContain("less-code");
  });

  test("in a task not marked as a refactor the implementer needs code-comments and less-code, not refactor", async () => {
    await startTask(false);
    await loadSourceSkills(IMPL_WORKER);
    await edit(IMPL_WORKER, SOURCE);
  });

  test("the test worker needs only unit-testing", async () => {
    await startTask(true);
    await loadSkill(TEST_WORKER, "unit-testing");
    await edit(TEST_WORKER, TEST);
  });

  test("the implementer editing a test file still gets the role guard's refusal", async () => {
    await startTask(true);
    await loadSkill(IMPL_WORKER, "unit-testing");
    await loadSkill(IMPL_WORKER, "refactor");
    await expect(edit(IMPL_WORKER, TEST)).rejects.toThrow(
      "mimir-impl may not modify test",
    );
  });
});

describe("the role guard refuses first", () => {
  test("an implementer editing a test file gets the role guard's refusal", async () => {
    await expect(edit(IMPL_WORKER, TEST)).rejects.toThrow(
      "mimir-impl may not modify test",
    );
    await loadSkill(IMPL_WORKER, "unit-testing");
    await expect(edit(IMPL_WORKER, TEST)).rejects.toThrow(
      "mimir-impl may not modify test",
    );
  });

  test("a coordinator in an active delegation may edit only its plan file", async () => {
    const planFile = join(home, "plan.md");
    await Bun.write(planFile, "# Plan\n");
    await writeCoordinatorState(MAIN, { active: true, planFile });
    await expect(edit(MAIN, SOURCE)).rejects.toThrow(
      "the coordinator delegates",
    );
    await loadSourceSkills(MAIN);
    await expect(edit(MAIN, SOURCE)).rejects.toThrow(
      "the coordinator delegates",
    );
    await edit(MAIN, planFile);
  });
});

describe("other tool calls are unaffected", () => {
  test("reads, shell, search and unknown tools need no skill", async () => {
    await beforeTool(MAIN, "read", { path: SOURCE });
    await beforeTool(MAIN, "read", { path: TEST });
    await beforeTool(MAIN, "shell", { command: "bun test" });
    await beforeTool(MAIN, "grep", { pattern: "x", path: "src" });
    await beforeTool(MAIN, "custom", { path: SOURCE });
    await beforeTool(TEST_WORKER, "read", { path: SOURCE });
    await beforeTool(IMPL_WORKER, "read", { path: TEST });
  });
});
