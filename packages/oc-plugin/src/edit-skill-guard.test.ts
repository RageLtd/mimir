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

/** The shared rule's own refusal for an edit to `path` with nothing loaded. */
const ruleReason = (path: string) => {
  const decision = editSkillDecision(join(ROOT, path), []);
  if (decision.allow) throw new Error(`${path} needs no skill`);
  return decision.reason;
};

const SOURCE_REASON = ruleReason(SOURCE);
const TEST_REASON = ruleReason(TEST);

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
    await edit(MAIN, SOURCE);
  });
});

describe("an edit needs its skill loaded", () => {
  for (const [label, [tool, input]] of Object.entries(writers(SOURCE))) {
    test(`${label} on a source file is refused until code-comments is loaded`, async () => {
      await expect(beforeTool(MAIN, tool, input)).rejects.toThrow(
        SOURCE_REASON,
      );
      await loadSkill(MAIN, "unit-testing");
      await expect(beforeTool(MAIN, tool, input)).rejects.toThrow(
        SOURCE_REASON,
      );
      await loadSkill(MAIN, "code-comments");
      await beforeTool(MAIN, tool, input);
    });
  }

  for (const [label, [tool, input]] of Object.entries(writers(TEST))) {
    test(`${label} on a test file is refused until unit-testing is loaded`, async () => {
      await expect(beforeTool(MAIN, tool, input)).rejects.toThrow(TEST_REASON);
      await loadSkill(MAIN, "code-comments");
      await expect(beforeTool(MAIN, tool, input)).rejects.toThrow(TEST_REASON);
      await loadSkill(MAIN, "unit-testing");
      await beforeTool(MAIN, tool, input);
    });
  }

  test("a patch touching a source and a test file needs both skills", async () => {
    const input = patch(
      `*** Update File: ${SOURCE}`,
      "@@",
      "-a",
      "+b",
      `*** Add File: ${TEST}`,
      "+x",
    );
    await loadSkill(MAIN, "code-comments");
    await expect(beforeTool(MAIN, "patch", input)).rejects.toThrow(TEST_REASON);
    await loadSkill(MAIN, "unit-testing");
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
    await loadSkill(MAIN, "code-comments");
    await loadSkill(MAIN, "unit-testing");
    await expect(edit("other", SOURCE)).rejects.toThrow(SOURCE_REASON);
    await expect(edit("other", TEST)).rejects.toThrow(TEST_REASON);
    await edit(MAIN, SOURCE);
  });

  test("a parent's skills do not cover its worker", async () => {
    await loadSkill(MAIN, "code-comments");
    await expect(edit(IMPL_WORKER, SOURCE)).rejects.toThrow(SOURCE_REASON);
  });
});

describe("Mimir's workers are held to the rule", () => {
  test("a test worker's edit to a test file waits for unit-testing", async () => {
    await expect(edit(TEST_WORKER, TEST)).rejects.toThrow(TEST_REASON);
    await loadSkill(TEST_WORKER, "unit-testing");
    await edit(TEST_WORKER, TEST);
  });

  test("an implementer's edit to a source file waits for code-comments", async () => {
    await expect(edit(IMPL_WORKER, SOURCE)).rejects.toThrow(SOURCE_REASON);
    await loadSkill(IMPL_WORKER, "code-comments");
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

  test("an implementer's edit to a source file waits for code-comments and refactor", async () => {
    await startTask(true);
    await expect(edit(IMPL_WORKER, SOURCE)).rejects.toThrow(/code-comments/);
    await loadSkill(IMPL_WORKER, "code-comments");
    await expect(edit(IMPL_WORKER, SOURCE)).rejects.toThrow(/refactor/);
    await loadSkill(IMPL_WORKER, "refactor");
    await edit(IMPL_WORKER, SOURCE);
  });

  test("refactor loaded first still leaves code-comments to load", async () => {
    await startTask(true);
    await loadSkill(IMPL_WORKER, "refactor");
    await expect(edit(IMPL_WORKER, SOURCE)).rejects.toThrow(/code-comments/);
    await loadSkill(IMPL_WORKER, "code-comments");
    await edit(IMPL_WORKER, SOURCE);
  });

  test("the refusal says to load refactor and then retry the edit", async () => {
    await startTask(true);
    await loadSkill(IMPL_WORKER, "code-comments");
    const refused = await edit(IMPL_WORKER, SOURCE).then(
      () => "",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(refused).toContain("refactor");
    expect(refused).toMatch(/\bload\b/i);
    expect(refused).toMatch(/\bretry\b/i);
  });

  test("in a task not marked as a refactor the implementer needs only code-comments", async () => {
    await startTask(false);
    await loadSkill(IMPL_WORKER, "code-comments");
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
    await loadSkill(MAIN, "code-comments");
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
