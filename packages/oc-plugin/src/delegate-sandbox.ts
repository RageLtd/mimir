/**
 * Test support for the delegate tools and the worker gate: a Mimir home and
 * a project directory per test, with git canned and the gate a recording
 * stand-in. Nothing here runs a command.
 */

import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { runVerify, VerifyOutcome } from "@mimir/plugin-core/verify";
import { cannedGit } from "@mimir/plugin-core/verify/testing";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { delegateTool } from "./delegate-tools";
import { gateTaskOutput } from "./worker-hooks";

export const COORDINATOR = "coordinator-session";
export const WORKER_SESSION = "worker-session";
export const HEAD = "c".repeat(40);
export const NEXT_HEAD = "d".repeat(40);

export const contextFor = (sessionID: string, agent: string) => {
  const context: ToolContext = {
    // Serialisation boundary: the SDK's context fields beyond these four
    // are not ours to construct.
    ...JSON.parse(
      JSON.stringify({ sessionID, messageID: "m", agent, id: "c" }),
    ),
    signal: new AbortController().signal,
    progress: async () => {},
  };
  return context;
};

export const coordinator = contextFor(COORDINATOR, "mimir");

/** A gate that records what it was asked and answers `outcome`. */
export const recordingGate = (
  outcome: VerifyOutcome = { kind: "pass", report: "✅ report" },
) => {
  const asked: Parameters<typeof runVerify>[0][] = [];
  const verify: typeof runVerify = async (options) => {
    asked.push(options);
    return outcome;
  };
  return { asked, verify };
};

/**
 * A fresh Mimir home and project directory for each test. The project is a
 * repository only as far as canned git says: `task` is told that HEAD is
 * the sandbox's current head. Call once at the top of a test file.
 */
export const delegateSandbox = () => {
  const dirs: string[] = [];
  const savedHome = process.env.MIMIR_HOME;
  const state = { home: "", root: "", head: HEAD };

  beforeEach(async () => {
    state.home = await mkdtemp(join(tmpdir(), "mimir-oc-delegate-"));
    dirs.push(state.home);
    state.root = join(state.home, "repo");
    state.head = HEAD;
    await mkdir(state.root);
    process.env.MIMIR_HOME = state.home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.MIMIR_HOME;
    else process.env.MIMIR_HOME = savedHome;
  });
  afterAll(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  const git = () => cannedGit({ "rev-parse --verify HEAD": `${state.head}\n` });

  /** `mimir_delegate` in the project directory, as a session's agent. */
  const delegate = async (
    input: Record<string, unknown>,
    context = coordinator,
  ) =>
    (await delegateTool(state.root, state.root, git()).execute(input, context))
      .content;

  return {
    /** The Mimir home; the plan lives here, outside the project. */
    home: () => state.home,
    root: () => state.root,
    /** What canned git reports as HEAD from now on. */
    moveHead: (head: string) => {
      state.head = head;
    },
    delegate,
    /** An active delegation whose plan is written. Returns the plan's path. */
    startDelegation: async () => {
      const planFile = join(state.home, "plan.md");
      await Bun.write(planFile, "# Plan\n");
      expect(await delegate({ action: "start", planFile })).toContain(
        "delegation active",
      );
      return planFile;
    },
    /**
     * A worker's result reaching the coordinator's `subagent` call, with
     * `gate` standing in for the verify gate.
     */
    handBack: async (
      agent: string,
      gate: ReturnType<typeof recordingGate>,
      child = "child",
    ) => {
      const output = { output: "STATUS: done", metadata: { sessionID: child } };
      const kind = await gateTaskOutput(
        {
          tool: "subagent",
          callID: child,
          sessionID: COORDINATOR,
          args: { agent },
        },
        output,
        state.root,
        { verify: gate.verify, commandTimeoutMs: 1 },
      );
      return { kind, text: output.output };
    },
  };
};
