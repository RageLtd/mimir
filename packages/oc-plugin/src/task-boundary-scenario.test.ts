/**
 * One task boundary followed through a whole task on OpenCode: it survives
 * every worker dispatched for the task, a restart of the delegation and the
 * coordinator's commits, and moves only when the next task is started. Git
 * is canned and the gate is a recording stand-in.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  readCoordinatorState,
  writeCoordinatorState,
} from "@mimir/plugin-core/guard";
import type { ChangeSource } from "@mimir/plugin-core/verify";
import {
  cannedGit,
  changed,
  changeSet,
} from "@mimir/plugin-core/verify/testing";
import { contextFor, delegateSandbox } from "./delegate-sandbox";
import { delegateTool, reviewPromptTool } from "./delegate-tools";
import {
  createSessionRoles,
  enforceRoleGuard,
  gateTaskOutput,
  type SessionInfo,
} from "./worker-hooks";

const { root: projectRoot } = delegateSandbox();

const rolesFor = (sessions: Record<string, SessionInfo>) =>
  createSessionRoles(async (id) => sessions[id] ?? null);

test("explicit task boundary survives fresh review-fix workers and refreshes even with reused workers", async () => {
  const root = projectRoot();
  // Each commit the coordinator makes is HEAD moving on.
  const commits = ["a", "b", "c", "d"].map((c) => c.repeat(40));
  let head = commits[0] ?? "";
  const commit = () => {
    head = commits[commits.indexOf(head) + 1] ?? "";
  };
  const delegate = () =>
    delegateTool(
      root,
      root,
      cannedGit({ "rev-parse --verify HEAD": `${head}\n` }),
    );
  const reviewed: ChangeSource = {
    collect: async (_worktree, taskBase) =>
      changeSet(
        [
          changed(
            "example.test.ts",
            null,
            'test("example", () => expect(1).toBe(1));\n',
          ),
        ],
        { base: taskBase },
      ),
    ownBase: async () => head,
  };
  const base = head;
  const planFile = join(root, "plan.md");
  await Bun.write(planFile, "# Plan");
  await writeCoordinatorState("parent", { active: true, planFile });
  const context = contextFor("parent", "mimir");
  await delegate().execute({ action: "task" }, context);
  const call = (agent: string, sessionID?: string) =>
    enforceRoleGuard(
      rolesFor({ parent: {} }),
      { tool: "subagent", sessionID: "parent" },
      { agent, sessionID },
      root,
    );
  await call("mimir-test");
  expect((await readCoordinatorState("parent"))?.task?.base).toBe(base);
  const seen: unknown[] = [];
  const output = {
    output: "STATUS: done",
    metadata: { sessionID: "test-child" },
  };
  await gateTaskOutput(
    {
      tool: "subagent",
      callID: "c",
      sessionID: "parent",
      args: { agent: "mimir-test" },
    },
    output,
    root,
    {
      verify: async (options) => {
        seen.push(options);
        return { kind: "pass", report: "ok" };
      },
      commandTimeoutMs: 1,
    },
  );
  expect(seen[0]).toMatchObject({ base, role: "test" });
  commit();
  await delegate().execute(
    { action: "start", planFile: join(root, "plan.md") },
    context,
  );
  expect((await readCoordinatorState("parent"))?.task?.base).toBe(base);
  commit();
  const review = await reviewPromptTool(
    root,
    undefined,
    root,
    reviewed,
  ).execute({ title: "Example" }, context);
  expect(review.content).toContain("example.test.ts");
  const roles = rolesFor({
    reviewer: { parentID: "parent", agent: "mimir-review" },
  });
  const childReview = await reviewPromptTool(
    root,
    roles.coordinatorSession,
    root,
    reviewed,
  ).execute({ title: "Example" }, contextFor("reviewer", "mimir"));
  expect(childReview.content).toContain("example.test.ts");
  await call("mimir-test", "test-child");
  await call("mimir-impl");
  await call("mimir-test"); // test assistance while implementation is blocked
  await call("mimir-review");
  await call("mimir-test"); // a fresh worker fixing reviewer findings is the same task
  expect((await readCoordinatorState("parent"))?.task?.base).toBe(base);
  await call("mimir-impl", "impl-child");
  expect((await readCoordinatorState("parent"))?.task?.base).toBe(base);
  await call("mimir-test", "test-child");
  expect((await readCoordinatorState("parent"))?.task?.base).toBe(base);
  await delegate().execute({ action: "task" }, context);
  await call("mimir-test", "test-child");
  expect(head).not.toBe(base);
  expect((await readCoordinatorState("parent"))?.task?.base).toBe(head);
  await call("mimir-review");
  commit();
  await delegate().execute({ action: "task" }, context);
  await call("mimir-impl", "impl-child");
  expect((await readCoordinatorState("parent"))?.task?.base).toBe(head);
  await gateTaskOutput(
    {
      tool: "subagent",
      callID: "next",
      sessionID: "parent",
      args: { agent: "mimir-impl", sessionID: "impl-child" },
    },
    { output: "STATUS: done", metadata: { sessionID: "impl-child" } },
    root,
    {
      verify: async (options) => {
        seen.push(options);
        return { kind: "pass", report: "ok" };
      },
      commandTimeoutMs: 1,
    },
  );
  expect(seen[1]).toMatchObject({
    base: head,
    agentId: "impl-child",
  });
});
