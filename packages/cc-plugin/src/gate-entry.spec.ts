/**
 * The gate entry: what a worker's hand-back and a manual `mimir-cc verify`
 * hand to the gate for the session's task, and what the hook answers. The
 * gate is a recording stand-in and git is canned, so no command runs; what
 * the gate does with these inputs is held in plugin-core.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { writeCoordinatorState } from "@mimir/plugin-core/guard";
import type { runVerify, VerifyOutcome } from "@mimir/plugin-core/verify";
import { cannedGit } from "@mimir/plugin-core/verify/testing";
import { captured, delegateSandbox, HEAD } from "./delegate-sandbox";
import { answerHandback, runVerifyHook, verifyForSession } from "./verify-hook";

const SESSION = "sess-gate-entry";
const WORKER = "impl-worker";
const DONE = "Made value 1.\n\nSTATUS: done";
const REMOVABLE = "pkg/first.spec.ts";
const DELETABLE = "pkg/gone.spec.ts";
const PASSED: VerifyOutcome = { kind: "pass", report: "✅ report" };
const BLOCKED: VerifyOutcome = { kind: "block", reason: "no tests", blocks: 1 };

/** A gate that records what it was asked and answers `outcome`. */
const recordingGate = (outcome: VerifyOutcome = PASSED) => {
  const asked: Parameters<typeof runVerify>[0][] = [];
  const verify: typeof runVerify = async (options) => {
    asked.push(options);
    return outcome;
  };
  return { asked, verify };
};

describe("the gate entry", () => {
  const { addWorker, repo, worktreeGit } = delegateSandbox(SESSION);
  let planFile: string;

  /** An active delegation whose task began at HEAD in the project directory. */
  const startTask = (extra: Record<string, unknown> = {}) =>
    writeCoordinatorState(SESSION, {
      active: true,
      planFile,
      task: { base: HEAD, worktree: repo(), ...extra },
    });

  const options = (worktree: string) => ({
    worktree,
    lastMessage: DONE,
    agentId: WORKER,
  });

  beforeEach(async () => {
    planFile = join(repo(), "plan.md");
    await Bun.write(planFile, "# plan\n");
  });

  describe("verifyForSession", () => {
    test("a worker's worktree is gated from the task base, against the integration worktree, with the task's allowances and mark", async () => {
      await startTask({
        allowedDeletions: [DELETABLE],
        allowedRemovals: [REMOVABLE],
        refactor: true,
      });
      const worker = addWorker(WORKER);
      const gate = recordingGate();

      await verifyForSession(SESSION, options(worker), {
        verify: gate.verify,
        run: worktreeGit(worker),
      });
      expect(gate.asked).toHaveLength(1);
      expect(gate.asked[0]).toMatchObject({
        worktree: worker,
        base: HEAD,
        integrationWorktree: repo(),
        allowedDeletions: [DELETABLE],
        allowedRemovals: [REMOVABLE],
        refactor: true,
        lastMessage: DONE,
        agentId: WORKER,
      });
    });

    test("the integration worktree itself is gated as the whole task: from the task base, with no integration worktree to narrow it", async () => {
      await startTask({ allowedRemovals: [REMOVABLE] });
      const gate = recordingGate();

      await verifyForSession(SESSION, options(repo()), {
        verify: gate.verify,
        run: worktreeGit(repo()),
      });
      expect(gate.asked[0]).toMatchObject({
        worktree: repo(),
        base: HEAD,
        allowedRemovals: [REMOVABLE],
      });
      expect(gate.asked[0]?.integrationWorktree).toBeUndefined();
    });

    test("a directory nested in the worker's worktree is gated at that worktree's top level", async () => {
      await startTask();
      const worker = addWorker(WORKER);
      const nested = join(worker, "nested");
      const gate = recordingGate();

      await verifyForSession(SESSION, options(nested), {
        verify: gate.verify,
        run: worktreeGit(worker, {
          [`${nested}$ rev-parse --git-common-dir`]: `${join(repo(), ".git")}\n`,
          [`${nested}$ rev-parse --show-toplevel`]: `${worker}\n`,
        }),
      });
      expect(gate.asked[0]?.worktree).toBe(worker);
    });

    test("with no delegation the gate gets the hand-back as it came, with no task base", async () => {
      const gate = recordingGate();

      await verifyForSession(SESSION, options(repo()), {
        verify: gate.verify,
        run: cannedGit({}),
      });
      expect(gate.asked[0]?.worktree).toBe(repo());
      expect(gate.asked[0]?.base).toBeUndefined();
      expect(gate.asked[0]?.integrationWorktree).toBeUndefined();
    });

    test("a task whose provenance cannot be proven blocks without running the gate", async () => {
      await writeCoordinatorState(SESSION, { active: true, planFile });
      const gate = recordingGate();

      const outcome = await verifyForSession(SESSION, options(repo()), {
        verify: gate.verify,
        run: cannedGit({}),
      });
      expect(outcome.kind).toBe("block");
      if (outcome.kind === "block")
        expect(outcome.reason).toContain("Cannot verify task provenance");
      expect(gate.asked).toEqual([]);
    });

    test("a hand-back that does not claim done goes to the gate without the task being consulted", async () => {
      await startTask();
      const gate = recordingGate({ kind: "skip", status: "question" });

      const outcome = await verifyForSession(
        SESSION,
        { ...options(repo()), lastMessage: "STATUS: question\nwhich?" },
        // Nothing is canned: asking git anything would throw.
        { verify: gate.verify, run: cannedGit({}) },
      );
      expect(outcome).toEqual({ kind: "skip", status: "question" });
      expect(gate.asked[0]?.base).toBeUndefined();
    });
  });

  describe("answerHandback", () => {
    /** A worker's hand-back, sent from the session's directory. */
    const handback = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        session_id: SESSION,
        cwd: repo(),
        agent_id: WORKER,
        agent_type: "mimir-impl",
        hook_event_name: "PreToolUse",
        tool_name: "SubagentHandback",
        tool_input: { message: DONE },
        ...extra,
      });

    test("a hand-back sent from the session's directory is gated in the worker's worktree, and a pass carries the report back", async () => {
      await startTask();
      const worker = addWorker(WORKER);
      const gate = recordingGate();

      const answer = await answerHandback(handback(), {
        verify: gate.verify,
        run: worktreeGit(worker),
      });
      expect(gate.asked[0]).toMatchObject({
        role: "impl",
        worktree: worker,
        base: HEAD,
        integrationWorktree: repo(),
        lastMessage: DONE,
        agentId: WORKER,
      });
      expect(answer?.hookSpecificOutput.permissionDecision).toBe("allow");
      expect(answer?.hookSpecificOutput.updatedInput?.message).toBe(
        `${DONE}\n\n✅ report`,
      );
    });

    test("a block is answered as a denial with the gate's reason", async () => {
      await startTask();
      const worker = addWorker(WORKER);

      const answer = await answerHandback(handback(), {
        verify: recordingGate(BLOCKED).verify,
        run: worktreeGit(worker),
      });
      expect(answer?.hookSpecificOutput).toMatchObject({
        permissionDecision: "deny",
        permissionDecisionReason: "no tests",
      });
    });

    test("an active delegation with no task boundary denies the hand-back", async () => {
      await writeCoordinatorState(SESSION, { active: true, planFile });
      const worker = addWorker(WORKER);
      const gate = recordingGate();

      const answer = await answerHandback(handback(), {
        verify: gate.verify,
        run: worktreeGit(worker),
      });
      expect(answer?.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(gate.asked).toEqual([]);
    });

    test("a SubagentStop payload claiming done is not acted on: no answer, no gate run", async () => {
      addWorker(WORKER);
      const gate = recordingGate();

      const answer = await answerHandback(
        handback({
          hook_event_name: "SubagentStop",
          tool_name: undefined,
          last_assistant_message: DONE,
        }),
        { verify: gate.verify, run: cannedGit({}) },
      );
      expect(answer).toBeNull();
      expect(gate.asked).toEqual([]);
    });

    test("a payload from outside a subagent gets no answer", async () => {
      const gate = recordingGate();

      const answer = await answerHandback(handback({ agent_id: undefined }), {
        verify: gate.verify,
        run: cannedGit({}),
      });
      expect(answer).toBeNull();
      expect(gate.asked).toEqual([]);
    });

    test("a worker whose worktree is gone gets no answer: the session's tree is not its change", async () => {
      await startTask();
      const gate = recordingGate();

      const answer = await answerHandback(handback(), {
        verify: gate.verify,
        run: worktreeGit(repo()),
      });
      expect(answer).toBeNull();
      expect(gate.asked).toEqual([]);
    });

    test("a gate that crashes lets the worker through with no answer", async () => {
      await startTask();
      const worker = addWorker(WORKER);
      const verify: typeof runVerify = async () => {
        throw new Error("gate fell over");
      };

      const answer = await answerHandback(handback(), {
        verify,
        run: worktreeGit(worker),
      });
      expect(answer).toBeNull();
    });
  });

  describe("mimir-cc verify --worktree", () => {
    test("a pass prints the report and exits 0, with the flags handed to the gate", async () => {
      await startTask();
      const gate = recordingGate();

      const ran = await captured(() =>
        runVerifyHook(
          ["--worktree", repo(), "--allow-empty", "--role", "test"],
          { verify: gate.verify, run: worktreeGit(repo()) },
        ),
      );
      expect(ran.code).toBe(0);
      expect(ran.stdout).toContain("✅ report");
      expect(gate.asked[0]).toMatchObject({
        worktree: repo(),
        base: HEAD,
        allowEmpty: true,
        role: "test",
      });
    });

    test("a block prints the reason and exits 1", async () => {
      await startTask();
      const worker = addWorker(WORKER);

      const ran = await captured(() =>
        runVerifyHook(["--worktree", worker], {
          verify: recordingGate(BLOCKED).verify,
          run: worktreeGit(worker),
        }),
      );
      expect(ran.code).toBe(1);
      expect(ran.stdout).toContain("no tests");
    });
  });
});
