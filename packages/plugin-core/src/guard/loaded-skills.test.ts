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
  loadedSkillsPath,
  readLoadedSkills,
  recordLoadedSkill,
} from "./loaded-skills";

const dirs: string[] = [];
const savedHome = process.env.MIMIR_HOME;

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "mimir-skills-"));
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

const MAIN = { sessionId: "s1" };
const SUBAGENT = { sessionId: "s1", agentId: "agent-a" };

describe("loaded skills record", () => {
  test("a loop with no record has nothing loaded", async () => {
    expect(await readLoadedSkills(MAIN)).toEqual([]);
    expect(await readLoadedSkills(SUBAGENT)).toEqual([]);
  });

  test("a recorded skill reads back for the loop that recorded it", async () => {
    await recordLoadedSkill(MAIN, "unit-testing");
    await recordLoadedSkill(MAIN, "mimir-cc:code-comments");
    expect(await readLoadedSkills(MAIN)).toEqual([
      "unit-testing",
      "mimir-cc:code-comments",
    ]);
  });

  test("recording the same skill twice keeps one entry", async () => {
    await recordLoadedSkill(MAIN, "unit-testing");
    await recordLoadedSkill(MAIN, "unit-testing");
    expect(await readLoadedSkills(MAIN)).toEqual(["unit-testing"]);
  });

  test("a skill a subagent recorded is not loaded for the main loop", async () => {
    await recordLoadedSkill(SUBAGENT, "unit-testing");
    expect(await readLoadedSkills(MAIN)).toEqual([]);
  });

  test("a skill the main loop recorded is not loaded for a subagent", async () => {
    await recordLoadedSkill(MAIN, "unit-testing");
    expect(await readLoadedSkills(SUBAGENT)).toEqual([]);
  });

  test("a skill one subagent recorded is not loaded for another", async () => {
    await recordLoadedSkill(SUBAGENT, "unit-testing");
    expect(
      await readLoadedSkills({ sessionId: "s1", agentId: "agent-b" }),
    ).toEqual([]);
  });

  test("a skill recorded in one session is not loaded in another", async () => {
    await recordLoadedSkill(MAIN, "unit-testing");
    await recordLoadedSkill(SUBAGENT, "code-comments");
    expect(await readLoadedSkills({ sessionId: "s2" })).toEqual([]);
    expect(
      await readLoadedSkills({ sessionId: "s2", agentId: "agent-a" }),
    ).toEqual([]);
  });

  test("the record is kept on disk under the Mimir home", async () => {
    await recordLoadedSkill(SUBAGENT, "unit-testing");
    const path = loadedSkillsPath(SUBAGENT);
    expect(path.startsWith(process.env.MIMIR_HOME ?? "\0")).toBe(true);
    expect(await Bun.file(path).exists()).toBe(true);

    await Bun.file(path).delete();
    expect(await readLoadedSkills(SUBAGENT)).toEqual([]);
  });

  test.each([
    "{not json",
    "42",
  ])("a record that cannot be parsed (%s) fails, naming the record", async (contents) => {
    const path = loadedSkillsPath(MAIN);
    await Bun.write(path, contents);
    const read = readLoadedSkills(MAIN);
    await expect(read).rejects.toThrow("loaded skills");
    await expect(read).rejects.toThrow(path);
  });
});
