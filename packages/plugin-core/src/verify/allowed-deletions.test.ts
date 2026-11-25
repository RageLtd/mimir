/**
 * Test files folded into one: the coordinator names the deleted test
 * files it accepts (`allowedDeletions`), the gate accepts those and no
 * others, and its pass report shows what the fold cost. Runs against a
 * real git repo; toolchain commands are intercepted so only git runs.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CommandRunner, runCommand } from "./exec";
import { runVerify } from "./verify";

const ADD_TEST = "add_test.go";
const SUB_TEST = "sub_test.go";
const FOLDED = "math_test.go";
const NOTES = "NOTES.md";
const ALLOWED_HEADER = "Allowed test deletions";
const ALLOWED_TOTALS = "Allowed deleted test files";
const OTHER_TOTALS = "Other changed test files";

const dirs: string[] = [];
const savedHome = process.env.MIMIR_HOME;

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "mimir-allowed-home-"));
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

const git = async (cwd: string, ...args: string[]) => {
  const r = await runCommand(["git", ...args], cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const write = async (root: string, rel: string, content: string) => {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await Bun.write(join(root, rel), content);
};

/** A Go test function with one assertion line per check. */
const goTest = (name: string, checks: readonly string[]) =>
  [
    `func ${name}(t *testing.T) {`,
    ...checks.map((c) => `\tif ${c} {\n\t\tt.Fatal("${name}")\n\t}`),
    "}",
  ].join("\n");

const goFile = (...tests: string[]) =>
  ["package x", 'import "testing"', ...tests, ""].join("\n");

/**
 * Base: two test files holding 3 test functions and 4 assertions —
 * add_test.go (TestAdd: 2, TestAddZero: 1), sub_test.go (TestSub: 1).
 */
const seedRepo = async () => {
  const root = await mkdtemp(join(tmpdir(), "mimir-allowed-repo-"));
  dirs.push(root);
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "t@example.com");
  await git(root, "config", "user.name", "t");
  await write(root, "go.mod", "module x\n");
  await write(
    root,
    "math.go",
    "package x\nfunc Add(a, b int) int { return a + b }\nfunc Sub(a, b int) int { return a - b }\n",
  );
  await write(
    root,
    ADD_TEST,
    goFile(
      goTest("TestAdd", ["Add(1, 2) != 3", "Add(2, 2) != 4"]),
      goTest("TestAddZero", ["Add(0, 0) != 0"]),
    ),
  );
  await write(root, SUB_TEST, goFile(goTest("TestSub", ["Sub(3, 1) != 2"])));
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "base");
  return root;
};

/**
 * Fold both test files into a new math_test.go: 2 test functions and
 * 3 assertions. Different enough from either original that git cannot
 * pair it with one as a move.
 */
const fold = async (root: string) => {
  await write(
    root,
    FOLDED,
    goFile(
      goTest("TestMathAdd", ["Add(1, 2) != 3", "Add(0, 0) != 0"]),
      goTest("TestMathSub", ["Sub(3, 1) != 2"]),
    ),
  );
  await rm(join(root, ADD_TEST));
  await rm(join(root, SUB_TEST));
};

const passingRunner: CommandRunner = async (argv, cwd, timeoutMs) =>
  argv[0] === "git"
    ? runCommand(argv, cwd, timeoutMs)
    : { code: 0, stdout: "", stderr: "", timedOut: false };

const verify = (root: string, agentId: string, allowed?: readonly string[]) =>
  runVerify({
    worktree: root,
    lastMessage: "STATUS: done",
    agentId,
    run: passingRunner,
    allowedDeletions: allowed,
  });

/** The indented lines under the allowed-deletions header. */
const allowedSection = (report: string) => {
  const lines = report.split("\n");
  const start = lines.findIndex((l) => l.startsWith(ALLOWED_HEADER));
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => !l.startsWith("  "));
  return (end === -1 ? rest : rest.slice(0, end)).map((l) => l.trim());
};

describe("verify gate: allowed test-file deletions", () => {
  test("without an allowance, folding two test files blocks on both deletions with the fold advice", async () => {
    const root = await seedRepo();
    await fold(root);

    const outcome = await verify(root, "fold-none");
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain(`${ADD_TEST}: test file deleted`);
    expect(outcome.reason).toContain(`${SUB_TEST}: test file deleted`);
    expect(outcome.reason).toMatch(/git (add|mv)/);
    expect(outcome.reason).toContain("STATUS: question");
  });

  test("allowing only one of the deletions still blocks on the other", async () => {
    const root = await seedRepo();
    await fold(root);

    const outcome = await verify(root, "fold-one", [ADD_TEST]);
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain(`${SUB_TEST}: test file deleted`);
    expect(outcome.reason).not.toContain(`${ADD_TEST}: test file deleted`);
  });

  test("an allowance for a path the change did not delete allows nothing", async () => {
    const root = await seedRepo();
    await fold(root);

    const outcome = await verify(root, "fold-wrong", ["other_test.go", FOLDED]);
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain(`${ADD_TEST}: test file deleted`);
    expect(outcome.reason).toContain(`${SUB_TEST}: test file deleted`);
  });

  test("both deletions allowed → pass, and the report shows what the fold cost", async () => {
    const root = await seedRepo();
    await fold(root);

    const outcome = await verify(root, "fold-all", [ADD_TEST, SUB_TEST]);
    expect(outcome.kind).toBe("pass");
    if (outcome.kind !== "pass") return;
    const { report } = outcome;
    expect(report).toContain(`${ALLOWED_HEADER} (2):`);
    expect(allowedSection(report).sort()).toEqual([ADD_TEST, SUB_TEST]);
    expect(report).toContain(
      `${ALLOWED_TOTALS}: 3 test functions, 4 assertions`,
    );
    // The folded file is new, so its before side is 0.
    expect(report).toContain(
      `${OTHER_TOTALS}: 0 → 2 test functions, 0 → 3 assertions`,
    );
    // The existing lines stay as they are.
    expect(report).toContain("Test functions: 3 → 2");
    expect(report).toContain(`D ${ADD_TEST}`);
    expect(report).toContain(`A ${FOLDED}`);
  });

  test("folding a deleted test file into an existing one shows that file's counts rising", async () => {
    const root = await seedRepo();
    // TestSub moves into add_test.go, which already held 2 test functions
    // and 3 assertions; add_test.go is changed, not added.
    await write(
      root,
      ADD_TEST,
      goFile(
        goTest("TestAdd", ["Add(1, 2) != 3", "Add(2, 2) != 4"]),
        goTest("TestAddZero", ["Add(0, 0) != 0"]),
        goTest("TestSub", ["Sub(3, 1) != 2"]),
      ),
    );
    await rm(join(root, SUB_TEST));

    const outcome = await verify(root, "fold-existing", [SUB_TEST]);
    expect(outcome.kind).toBe("pass");
    if (outcome.kind !== "pass") return;
    const { report } = outcome;
    expect(report).toContain(`${ALLOWED_HEADER} (1):`);
    expect(allowedSection(report)).toEqual([SUB_TEST]);
    expect(report).toContain(
      `${ALLOWED_TOTALS}: 1 test functions, 1 assertions`,
    );
    expect(report).toContain(
      `${OTHER_TOTALS}: 2 → 3 test functions, 3 → 4 assertions`,
    );
  });

  test("an allowed path that was deleted but is not a test file is neither listed nor counted", async () => {
    const root = await seedRepo();
    await write(root, NOTES, "notes\n");
    await git(root, "add", NOTES);
    await git(root, "commit", "-q", "-m", "notes");
    await fold(root);
    await rm(join(root, NOTES));

    const outcome = await verify(root, "fold-notes", [
      ADD_TEST,
      SUB_TEST,
      NOTES,
    ]);
    expect(outcome.kind).toBe("pass");
    if (outcome.kind !== "pass") return;
    const { report } = outcome;
    expect(report).toContain(`${ALLOWED_HEADER} (2):`);
    expect(allowedSection(report).sort()).toEqual([ADD_TEST, SUB_TEST]);
    expect(report).toContain(
      `${ALLOWED_TOTALS}: 3 test functions, 4 assertions`,
    );
    expect(report).toContain(
      `${OTHER_TOTALS}: 0 → 2 test functions, 0 → 3 assertions`,
    );
  });

  test("an allowed deletion does not excuse a skip added in the folded file", async () => {
    const root = await seedRepo();
    await fold(root);
    await write(
      root,
      FOLDED,
      goFile(
        goTest("TestMathAdd", ["Add(1, 2) != 3", "Add(0, 0) != 0"]),
        'func TestMathSub(t *testing.T) {\n\tt.Skip("later")\n\tif Sub(3, 1) != 2 {\n\t\tt.Fatal("sub")\n\t}\n}',
      ),
    );

    const outcome = await verify(root, "fold-skip", [ADD_TEST, SUB_TEST]);
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") expect(outcome.reason).toContain("skip");
  });

  test("with no allowance, a pass report carries no allowed-deletions lines", async () => {
    const root = await seedRepo();
    await write(
      root,
      SUB_TEST,
      goFile(
        goTest("TestSub", ["Sub(3, 1) != 2"]),
        goTest("TestSubZero", ["Sub(0, 0) != 0"]),
      ),
    );

    const outcome = await verify(root, "plain");
    expect(outcome.kind).toBe("pass");
    if (outcome.kind !== "pass") return;
    expect(outcome.report).toContain("Test functions: 1 → 2");
    expect(outcome.report).not.toContain(ALLOWED_HEADER);
    expect(outcome.report).not.toContain(ALLOWED_TOTALS);
    expect(outcome.report).not.toContain(OTHER_TOTALS);
  });
});
