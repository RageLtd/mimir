/**
 * End-to-end gate against a real git repo; toolchain commands are
 * intercepted by an injected runner so nothing but git actually runs.
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

const dirs: string[] = [];
const savedHome = process.env.MIMIR_HOME;

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "mimir-verify-home-"));
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

/** A Go repo (manifest fallback resolves `go test ./...` etc.). */
const seedRepo = async () => {
  const root = await mkdtemp(join(tmpdir(), "mimir-verify-repo-"));
  dirs.push(root);
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "t@example.com");
  await git(root, "config", "user.name", "t");
  await write(root, "go.mod", "module x\n");
  await write(
    root,
    "add.go",
    "package x\nfunc Add(a, b int) int { return a + b }\n",
  );
  await write(
    root,
    "add_test.go",
    'package x\nimport "testing"\nfunc TestAdd(t *testing.T) { if Add(1,2) != 3 { t.Fatal("bad") } }\n',
  );
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "base");
  return root;
};

/** Passes git through; scripts toolchain commands by name. */
const runner =
  (
    outcomes: Record<string, { code: number; out?: string }>,
    seen: string[] = [],
  ): CommandRunner =>
  async (argv, cwd, timeoutMs) => {
    if (argv[0] === "git") return runCommand(argv, cwd, timeoutMs);
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

describe("runVerify", () => {
  test("STATUS other than done → skip, nothing runs", async () => {
    const root = await seedRepo();
    const seen: string[] = [];
    const outcome = await runVerify({
      worktree: root,
      lastMessage: "STATUS: question\nwhich?",
      agentId: "a",
      run: runner({}, seen),
    });
    expect(outcome).toEqual({ kind: "skip", status: "question" });
    expect(seen).toEqual([]);
  });

  test("done with no changes → block", async () => {
    const root = await seedRepo();
    const outcome = await runVerify({
      worktree: root,
      lastMessage: "STATUS: done",
      agentId: "a",
      run: runner({}),
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block")
      expect(outcome.reason).toContain("No changes");
  });

  test("source change without a test → coverage block; commands never run", async () => {
    const root = await seedRepo();
    await write(
      root,
      "add.go",
      "package x\nfunc Add(a, b int) int { return a + b + 0 }\n",
    );
    const seen: string[] = [];
    const outcome = await runVerify({
      worktree: root,
      lastMessage: "STATUS: done",
      agentId: "a",
      run: runner({}, seen),
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block")
      expect(outcome.reason).toContain("No test coverage");
    expect(seen).toEqual([]);
  });

  test("red tests committed on the branch cover a source-only worker diff", async () => {
    const root = await seedRepo();
    await git(root, "checkout", "-q", "-b", "integration");
    await write(
      root,
      "add_test.go",
      'package x\nimport "testing"\nfunc TestAdd(t *testing.T) { if Add(1,2) != 3 { t.Fatal("bad") } }\nfunc TestAddZero(t *testing.T) { if Add(0,0) != 0 { t.Fatal("bad") } }\n',
    );
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "tests (red)");
    const wt = join(root, ".claude", "worktrees", "impl");
    await git(root, "worktree", "add", "-q", "-b", "impl", wt);
    await write(
      wt,
      "add.go",
      "package x\nfunc Add(a, b int) int { return a + b + 0 }\n",
    );
    const seen: string[] = [];
    const outcome = await runVerify({
      worktree: wt,
      lastMessage: "STATUS: done",
      agentId: "a",
      run: runner({}, seen),
    });
    expect(outcome.kind).toBe("pass");
    expect(seen.length).toBeGreaterThan(0);
  });

  test("clean change with a test → commands run in order → pass with report", async () => {
    const root = await seedRepo();
    await write(
      root,
      "add.go",
      "package x\nfunc Add(a, b int) int { return a + b }\nfunc Sub(a, b int) int { return a - b }\n",
    );
    await write(
      root,
      "add_test.go",
      'package x\nimport "testing"\nfunc TestAdd(t *testing.T) { if Add(1,2) != 3 { t.Fatal("bad") } }\nfunc TestSub(t *testing.T) { if Sub(3,1) != 2 { t.Fatal("bad") } }\n',
    );
    const seen: string[] = [];
    const outcome = await runVerify({
      worktree: root,
      lastMessage: "done!\nSTATUS: done",
      agentId: "a",
      run: runner({}, seen),
    });
    expect(seen).toEqual(["go build ./...", "go test ./...", "go vet ./..."]);
    expect(outcome.kind).toBe("pass");
    if (outcome.kind === "pass") {
      expect(outcome.report).toContain("Verify gate passed");
      expect(outcome.report).toContain("M add.go");
      expect(outcome.report).toContain("Test functions: 1 → 2");
      expect(outcome.report).toContain("✓ test: go test ./...");
    }
  });

  test("failing command → block with the output tail; loop guard counts to exhaustion", async () => {
    const root = await seedRepo();
    await write(
      root,
      "add.go",
      "package x\nfunc Add(a, b int) int { return a + b }\nfunc Mul(a, b int) int { return a * b }\n",
    );
    await write(
      root,
      "add_test.go",
      'package x\nimport "testing"\nfunc TestMul(t *testing.T) { if Mul(2,2) != 4 { t.Fatal("bad") } }\n',
    );
    const run = runner({
      "go test ./...": { code: 1, out: "--- FAIL: TestMul\nFAIL\n" },
    });
    const opts = {
      worktree: root,
      lastMessage: "STATUS: done",
      agentId: "loop",
      run,
    };

    const first = await runVerify(opts);
    expect(first.kind).toBe("block");
    if (first.kind === "block") {
      expect(first.blocks).toBe(1);
      expect(first.reason).toContain("block 1/3");
      expect(first.reason).toContain("--- FAIL: TestMul");
    }
    const second = await runVerify(opts);
    expect(second.kind).toBe("block");
    const third = await runVerify(opts);
    expect(third.kind).toBe("exhausted");
    if (third.kind === "exhausted") {
      expect(third.blocks).toBe(3);
      expect(third.reason).toContain("STATUS: failed");
    }
  });

  test("no toolchain for a root → block naming it", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimir-verify-bare-"));
    dirs.push(root);
    await git(root, "init", "-q", "-b", "main");
    await git(root, "config", "user.email", "t@example.com");
    await git(root, "config", "user.name", "t");
    await write(root, "main.zig", "pub fn main() void {}\n");
    await git(root, "add", ".");
    await git(root, "commit", "-q", "-m", "base");
    await write(root, "lib.py", "def f():\n    return 1\n");
    await write(root, "test_lib.py", "def test_f():\n    assert f() == 1\n");
    const outcome = await runVerify({
      worktree: root,
      lastMessage: "STATUS: done",
      agentId: "z",
      run: runner({}),
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") {
      expect(outcome.reason).toContain("No verification toolchain");
      expect(outcome.reason).toContain("mimir.toml");
    }
  });

  test("role test: red tests are expected, so the test command is skipped", async () => {
    const root = await seedRepo();
    await write(
      root,
      "sub_test.go",
      'package x\nimport "testing"\nfunc TestSub(t *testing.T) { if Sub(3,1) != 2 { t.Fatal("bad") } }\n',
    );
    const seen: string[] = [];
    const outcome = await runVerify({
      role: "test",
      worktree: root,
      lastMessage: "STATUS: done",
      agentId: "t",
      run: runner({ "go test ./...": { code: 1 } }, seen),
    });
    // Red-first tests may not even compile yet (a new export under test), so
    // typecheck is skipped for the test role along with the test command.
    expect(seen).toEqual(["go vet ./..."]);
    expect(outcome.kind).toBe("pass");
  });

  test("role test: sanity still applies (a skipped test is wrong)", async () => {
    const root = await seedRepo();
    await write(
      root,
      "skip_test.go",
      'package x\nimport "testing"\nfunc TestSkip(t *testing.T) { t.Skip("later") }\n',
    );
    const outcome = await runVerify({
      role: "test",
      worktree: root,
      lastMessage: "STATUS: done",
      agentId: "t2",
      run: runner({}),
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block") expect(outcome.reason).toContain("skip");
  });

  test("no verification command ran → block (a pass that checked nothing is worthless)", async () => {
    const root = await seedRepo();
    // Explicit config with only `test`: the test role skips it, leaving nothing.
    await write(root, "mimir.toml", '[verify]\ntest = "run-tests"\n');
    await write(
      root,
      "add_test.go",
      'package x\nimport "testing"\nfunc TestAdd(t *testing.T) { if Add(1,2) != 3 { t.Fatal("bad") } }\nfunc TestMore(t *testing.T) { if Add(2,2) != 4 { t.Fatal("bad") } }\n',
    );
    const seen: string[] = [];
    const outcome = await runVerify({
      role: "test",
      worktree: root,
      lastMessage: "STATUS: done",
      agentId: "none",
      run: runner({}, seen),
    });
    expect(seen).toEqual([]);
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block")
      expect(outcome.reason).toContain("No verification command ran");
  });

  test("allowEmpty: a clean tree runs the project root's toolchain and passes", async () => {
    const root = await seedRepo();
    const seen: string[] = [];
    const outcome = await runVerify({
      allowEmpty: true,
      worktree: root,
      lastMessage: "STATUS: done",
      agentId: "integration",
      run: runner({}, seen),
    });
    expect(seen).toEqual(["go build ./...", "go test ./...", "go vet ./..."]);
    expect(outcome.kind).toBe("pass");
    if (outcome.kind === "pass")
      expect(outcome.report).toContain("Changed files (0)");
  });

  test("role review: the gate does not apply", async () => {
    const root = await seedRepo();
    const outcome = await runVerify({
      role: "review",
      worktree: root,
      lastMessage: "Findings: none.\nSTATUS: done",
      agentId: "r",
      run: runner({}),
    });
    expect(outcome).toEqual({ kind: "skip", status: "done" });
  });

  test("a pass clears the loop guard", async () => {
    const root = await seedRepo();
    await write(
      root,
      "add.go",
      "package x\nfunc Add(a, b int) int { return a + b }\n// note\n",
    );
    await write(
      root,
      "add_test.go",
      'package x\nimport "testing"\nfunc TestAdd(t *testing.T) { if Add(1,2) != 3 { t.Fatal("bad") } }\nfunc TestAdd2(t *testing.T) { if Add(2,2) != 4 { t.Fatal("bad") } }\n',
    );
    const failing = runner({ "go test ./...": { code: 1 } });
    const passing = runner({});
    const base = {
      worktree: root,
      lastMessage: "STATUS: done",
      agentId: "clear",
    };
    expect((await runVerify({ ...base, run: failing })).kind).toBe("block");
    expect((await runVerify({ ...base, run: passing })).kind).toBe("pass");
    const again = await runVerify({ ...base, run: failing });
    expect(again.kind).toBe("block");
    if (again.kind === "block") expect(again.blocks).toBe(1);
  });
});
