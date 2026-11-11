/**
 * The gate and checks that need the code to build (`vet`), against a real
 * git repo holding a Rust crate. Toolchain commands are intercepted by an
 * injected runner, so nothing but git actually runs.
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

const FMT = "cargo fmt --check";
const BUILD = "cargo check --all-targets";
const TEST = "cargo test";
const VET = "cargo clippy --all-targets -- -D warnings";
const DONE = "STATUS: done";

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

/** A Rust crate with one uncommitted red test for a function not written yet. */
const seedRedTest = async () => {
  const root = await mkdtemp(join(tmpdir(), "mimir-verify-rust-"));
  dirs.push(root);
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "t@example.com");
  await git(root, "config", "user.name", "t");
  await write(root, "Cargo.toml", '[package]\nname = "x"\n');
  await write(
    root,
    "src/lib.rs",
    "pub fn add(a: i32, b: i32) -> i32 { a + b }\n",
  );
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "base");
  await write(
    root,
    "src/lib/tests.rs",
    "use super::*;\n#[test]\nfn subtracts() { assert_eq!(sub(3, 1), 2); }\n",
  );
  return root;
};

/** Passes git through; scripts toolchain commands by name. */
const runner =
  (
    outcomes: Record<string, { code: number; out?: string }>,
    seen: string[],
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

describe("runVerify with a vet command", () => {
  test("role test: a red test that does not build yet passes, with the vet skipped and said so", async () => {
    const root = await seedRedTest();
    const seen: string[] = [];
    const outcome = await runVerify({
      role: "test",
      worktree: root,
      lastMessage: DONE,
      agentId: "red-no-build",
      run: runner({ [BUILD]: { code: 101 } }, seen),
    });
    // The build is only a probe here: clippy cannot run on code that does
    // not compile, and not compiling is what red means in Rust.
    expect(seen).toEqual([FMT, BUILD]);
    expect(outcome.kind).toBe("pass");
    if (outcome.kind === "pass") {
      expect(outcome.report).toContain("does not build yet");
      expect(outcome.report).toContain(VET);
    }
  });

  test("role test: a red test that builds is still vetted", async () => {
    const root = await seedRedTest();
    const seen: string[] = [];
    const outcome = await runVerify({
      role: "test",
      worktree: root,
      lastMessage: DONE,
      agentId: "red-builds",
      run: runner({ [VET]: { code: 101, out: "needless clone" } }, seen),
    });
    expect(seen).toEqual([FMT, BUILD, VET]);
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block")
      expect(outcome.reason).toContain("needless clone");
  });

  test("role test: a red test that builds and vets clean passes without a skip note", async () => {
    const root = await seedRedTest();
    const seen: string[] = [];
    const outcome = await runVerify({
      role: "test",
      worktree: root,
      lastMessage: DONE,
      agentId: "red-clean",
      run: runner({}, seen),
    });
    expect(seen).toEqual([FMT, BUILD, VET]);
    expect(outcome.kind).toBe("pass");
    if (outcome.kind === "pass")
      expect(outcome.report).not.toContain("does not build yet");
  });

  test("role test: a formatting failure blocks before the build is probed", async () => {
    const root = await seedRedTest();
    const seen: string[] = [];
    const outcome = await runVerify({
      role: "test",
      worktree: root,
      lastMessage: DONE,
      agentId: "red-fmt",
      run: runner({ [FMT]: { code: 1 } }, seen),
    });
    expect(seen).toEqual([FMT]);
    expect(outcome.kind).toBe("block");
  });

  test("role impl: a build failure blocks, and the vet runs last when all is well", async () => {
    const root = await seedRedTest();
    await write(
      root,
      "src/lib.rs",
      "pub fn add(a: i32, b: i32) -> i32 { a + b }\npub fn sub(a: i32, b: i32) -> i32 { a - b }\n",
    );
    const options = { worktree: root, lastMessage: DONE, agentId: "impl" };

    const broken: string[] = [];
    const blocked = await runVerify({
      ...options,
      run: runner({ [BUILD]: { code: 101 } }, broken),
    });
    expect(broken).toEqual([BUILD]);
    expect(blocked.kind).toBe("block");

    const seen: string[] = [];
    const passed = await runVerify({ ...options, run: runner({}, seen) });
    expect(seen).toEqual([BUILD, TEST, FMT, VET]);
    expect(passed.kind).toBe("pass");
  });
});
