/**
 * The gate and the check that needs the code to build (`vet`), for a Rust
 * crate. The change set is handed in and toolchain commands are scripted,
 * so no command runs.
 */

import { describe, expect, test } from "bun:test";
import {
  changed,
  changeSet,
  fixedChanges,
  gateSandbox,
  toolchain,
} from "./change-fixtures.test-helpers";
import { runVerify } from "./verify";

const FMT = "cargo fmt --check";
const BUILD = "cargo check --all-targets";
const TEST = "cargo test";
const VET = "cargo clippy --all-targets -- -D warnings";
const DONE = "STATUS: done";

const CRATE = { "Cargo.toml": '[package]\nname = "x"\n' };
const LIB = "pub fn add(a: i32, b: i32) -> i32 { a + b }\n";
const LIB_WITH_SUB =
  "pub fn add(a: i32, b: i32) -> i32 { a + b }\npub fn sub(a: i32, b: i32) -> i32 { a - b }\n";

/** A red test for a function not written yet. */
const RED_TEST = changed(
  "src/lib/tests.rs",
  null,
  "use super::*;\n#[test]\nfn subtracts() { assert_eq!(sub(3, 1), 2); }\n",
);

const { project } = gateSandbox();

describe("runVerify with a vet command", () => {
  test("role test: a red test that does not build yet passes, with the vet skipped and said so", async () => {
    const root = await project(CRATE);
    const seen: string[] = [];
    const outcome = await runVerify({
      role: "test",
      worktree: root,
      lastMessage: DONE,
      agentId: "red-no-build",
      changes: fixedChanges(changeSet([RED_TEST])),
      run: toolchain({ [BUILD]: { code: 101 } }, seen),
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
    const root = await project(CRATE);
    const seen: string[] = [];
    const outcome = await runVerify({
      role: "test",
      worktree: root,
      lastMessage: DONE,
      agentId: "red-builds",
      changes: fixedChanges(changeSet([RED_TEST])),
      run: toolchain({ [VET]: { code: 101, out: "needless clone" } }, seen),
    });
    expect(seen).toEqual([FMT, BUILD, VET]);
    expect(outcome.kind).toBe("block");
    if (outcome.kind === "block")
      expect(outcome.reason).toContain("needless clone");
  });

  test("role test: a red test that builds and vets clean passes without a skip note", async () => {
    const root = await project(CRATE);
    const seen: string[] = [];
    const outcome = await runVerify({
      role: "test",
      worktree: root,
      lastMessage: DONE,
      agentId: "red-clean",
      changes: fixedChanges(changeSet([RED_TEST])),
      run: toolchain({}, seen),
    });
    expect(seen).toEqual([FMT, BUILD, VET]);
    expect(outcome.kind).toBe("pass");
    if (outcome.kind === "pass")
      expect(outcome.report).not.toContain("does not build yet");
  });

  test("role test: a formatting failure blocks before the build is probed", async () => {
    const root = await project(CRATE);
    const seen: string[] = [];
    const outcome = await runVerify({
      role: "test",
      worktree: root,
      lastMessage: DONE,
      agentId: "red-fmt",
      changes: fixedChanges(changeSet([RED_TEST])),
      run: toolchain({ [FMT]: { code: 1 } }, seen),
    });
    expect(seen).toEqual([FMT]);
    expect(outcome.kind).toBe("block");
  });

  test("role impl: a build failure blocks, and the vet runs last when all is well", async () => {
    const root = await project(CRATE);
    const options = {
      worktree: root,
      lastMessage: DONE,
      agentId: "impl",
      changes: fixedChanges(
        changeSet([RED_TEST, changed("src/lib.rs", LIB, LIB_WITH_SUB)]),
      ),
    };

    const broken: string[] = [];
    const blocked = await runVerify({
      ...options,
      run: toolchain({ [BUILD]: { code: 101 } }, broken),
    });
    expect(broken).toEqual([BUILD]);
    expect(blocked.kind).toBe("block");

    const seen: string[] = [];
    const passed = await runVerify({ ...options, run: toolchain({}, seen) });
    expect(seen).toEqual([BUILD, TEST, FMT, VET]);
    expect(passed.kind).toBe("pass");
  });
});
