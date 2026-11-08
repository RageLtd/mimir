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
  readCoordinatorState,
  writeCoordinatorState,
} from "@mimir/plugin-core/guard";
import { runCommand, type VerifyOutcome } from "@mimir/plugin-core/verify";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { delegateTool, reviewPromptTool } from "./delegate-tools";
import {
  appendVerdict,
  createSessionRoles,
  enforceRoleGuard,
  gateTaskOutput,
  guardReason,
  type SessionInfo,
  sessionLookupFrom,
} from "./worker-hooks";

const dirs: string[] = [];
const savedHome = process.env.MIMIR_HOME;

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "mimir-oc-hooks-"));
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

const rolesFor = (
  sessions: Record<string, SessionInfo>,
  calls: string[] = [],
) =>
  createSessionRoles(async (id) => {
    calls.push(id);
    return sessions[id] ?? null;
  });

test("explicit task boundary survives fresh review-fix workers and refreshes even with reused workers", async () => {
  const root = dirs[dirs.length - 1] ?? "";
  const git = async (...args: string[]) => {
    const result = await runCommand(["git", ...args], root);
    expect(result.code).toBe(0);
    return result.stdout.trim();
  };
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "t");
  await git("commit", "--allow-empty", "-qm", "base");
  const base = await git("rev-parse", "HEAD");
  const planFile = join(root, "plan.md");
  await Bun.write(planFile, "# Plan");
  await writeCoordinatorState("parent", { active: true, planFile });
  const context: ToolContext = {
    ...JSON.parse(
      '{"sessionID":"parent","messageID":"m","agent":"mimir","id":"c"}',
    ),
    signal: new AbortController().signal,
    progress: async () => {},
  };
  await delegateTool(root).execute({ action: "task" }, context);
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
  await git("commit", "--allow-empty", "-qm", "tests");
  await delegateTool(root).execute(
    { action: "start", planFile: join(root, "plan.md") },
    context,
  );
  expect((await readCoordinatorState("parent"))?.task?.base).toBe(base);
  await Bun.write(
    join(root, "example.test.ts"),
    'test("example", () => expect(1).toBe(1));\n',
  );
  await git("add", "example.test.ts");
  await git("commit", "-qm", "test content");
  const review = await reviewPromptTool(root).execute(
    { title: "Example" },
    context,
  );
  expect(review.content).toContain("example.test.ts");
  const roles = rolesFor({
    reviewer: { parentID: "parent", agent: "mimir-review" },
  });
  const childReview = await reviewPromptTool(
    root,
    roles.coordinatorSession,
  ).execute(
    { title: "Example" },
    { ...context, ...JSON.parse('{"sessionID":"reviewer"}') },
  );
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
  await delegateTool(root).execute({ action: "task" }, context);
  await call("mimir-test", "test-child");
  expect((await readCoordinatorState("parent"))?.task?.base).toBe(
    await git("rev-parse", "HEAD"),
  );
  await call("mimir-review");
  await git("commit", "--allow-empty", "-qm", "next task accepted");
  await delegateTool(root).execute({ action: "task" }, context);
  await call("mimir-impl", "impl-child");
  expect((await readCoordinatorState("parent"))?.task?.base).toBe(
    await git("rev-parse", "HEAD"),
  );
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
    base: await git("rev-parse", "HEAD"),
    agentId: "impl-child",
  });
});

test("dispatch leaves default calls alone but requires an explicit task for coordinators", async () => {
  const root = dirs[dirs.length - 1] ?? "";
  const input = {
    tool: "subagent",
    sessionID: "parent",
  };
  const roles = rolesFor({ parent: {} });
  await enforceRoleGuard(roles, input, { agent: "mimir-test" }, root);
  expect(await readCoordinatorState("parent")).toBeNull();
  const planFile = join(root, "plan.md");
  await Bun.write(planFile, "# Plan");
  await writeCoordinatorState("parent", { active: true, planFile });
  await expect(
    enforceRoleGuard(roles, input, { agent: "mimir-test" }, root),
  ).rejects.toThrow("task");
  const output = { output: "STATUS: done", metadata: {} };
  expect(
    await gateTaskOutput(
      {
        tool: "subagent",
        callID: "c",
        sessionID: "parent",
        args: { agent: "mimir-impl" },
      },
      output,
      root,
    ),
  ).toBe("block");
  expect(output.output).toContain("missing task base");
});

describe("createSessionRoles", () => {
  test("V2 lookup returns direct session info and retries failed lookups", async () => {
    const calls: string[] = [];
    const roles = createSessionRoles(
      sessionLookupFrom({
        session: {
          get: async ({ sessionID }) => {
            calls.push(sessionID);
            if (calls.length === 1) throw new Error("offline");
            return { parentID: "main", agent: "mimir-test" };
          },
        },
      }),
    );
    expect(await roles.workerRole("w")).toBeNull();
    expect(await roles.workerRole("w")).toBe("test");
    expect(calls).toEqual(["w", "w"]);
    roles.invalidate("w");
    expect(await roles.isChild("w")).toBe(true);
    expect(calls).toHaveLength(3);
  });

  test("a rejected lookup is not cached", async () => {
    let calls = 0;
    const roles = createSessionRoles(async () => {
      if (++calls === 1) throw new Error("offline");
      return { parentID: "main" };
    });
    expect(await roles.isChild("w")).toBe(false);
    expect(await roles.isChild("w")).toBe(true);
  });
  test("child + mimir agent → role; main session → none; lookups cached", async () => {
    const calls: string[] = [];
    const roles = rolesFor(
      {
        main: {},
        w1: { parentID: "main", agent: "mimir-impl" },
        w2: { parentID: "main", agent: "general" },
      },
      calls,
    );
    expect(await roles.workerRole("w1")).toBe("impl");
    expect(await roles.workerRole("w2")).toBeNull();
    expect(await roles.workerRole("main")).toBeNull();
    expect(await roles.isChild("w1")).toBe(true);
    expect(await roles.isChild("main")).toBe(false);
    await roles.workerRole("w1");
    expect(calls.filter((c) => c === "w1")).toHaveLength(1);
  });
});

describe("guardReason", () => {
  const WT = "/work/repo";

  test("active tool-hook agent overrides cached agent, including nonworker agents", async () => {
    const roles = rolesFor({ w: { parentID: "main", agent: "mimir-impl" } });
    expect(
      await guardReason(
        roles,
        { tool: "edit", sessionID: "w", agent: "mimir-test" },
        { filePath: "a.ts" },
        WT,
      ),
    ).toContain("mimir-test");
    expect(
      await guardReason(
        roles,
        { tool: "edit", sessionID: "w", agent: "general" },
        { filePath: "a.test.ts" },
        WT,
      ),
    ).toBeNull();
    expect(
      await guardReason(
        roles,
        { tool: "shell", sessionID: "w", agent: "mimir-impl" },
        { command: "git push" },
        WT,
      ),
    ).toContain("never push");
  });

  test("secret reads denied for any session", async () => {
    const roles = rolesFor({ main: {} });
    const reason = await guardReason(
      roles,
      { tool: "read", sessionID: "main" },
      { filePath: ".env" },
      WT,
    );
    expect(reason).toContain("credentials");
    expect(
      await guardReason(
        roles,
        { tool: "Read", sessionID: "main" },
        { file_path: ".env" },
        WT,
      ),
    ).toContain("credentials");
    expect(
      await guardReason(
        roles,
        { tool: "read", sessionID: "main" },
        { path: ".env" },
        WT,
      ),
    ).toContain("credentials");
  });

  test("worker role enforced from the session's agent", async () => {
    const roles = rolesFor({ w: { parentID: "main", agent: "mimir-impl" } });
    expect(
      await guardReason(
        roles,
        { tool: "edit", sessionID: "w" },
        { filePath: "a.test.ts" },
        WT,
      ),
    ).toContain("mimir-impl");
    expect(
      await guardReason(
        roles,
        { tool: "patch", sessionID: "w" },
        { filePath: "a.test.ts", patchText: "patch" },
        WT,
      ),
    ).toContain("mimir-impl");
    expect(
      await guardReason(
        roles,
        { tool: "edit", sessionID: "w" },
        { filePath: "a.ts" },
        WT,
      ),
    ).toBeNull();
    expect(
      await guardReason(
        roles,
        { tool: "bash", sessionID: "w" },
        { command: "git push" },
        WT,
      ),
    ).toContain("never push");
  });

  test("main session without coordinator state is unguarded; with it, spawn needs the plan", async () => {
    const roles = rolesFor({ main: {} });
    expect(
      await guardReason(
        roles,
        { tool: "edit", sessionID: "main" },
        { filePath: "a.test.ts" },
        WT,
      ),
    ).toBeNull();

    const planFile = join(dirs[dirs.length - 1] ?? "", "plan.md");
    await writeCoordinatorState("main", { active: true, planFile });
    expect(
      await guardReason(
        roles,
        { tool: "subagent", sessionID: "main" },
        { prompt: "x" },
        WT,
      ),
    ).toContain("plan file");
    expect(
      await guardReason(
        roles,
        { tool: "edit", sessionID: "main" },
        { filePath: "a.ts" },
        WT,
      ),
    ).toContain("delegates");
    await Bun.write(planFile, "# plan");
    await writeCoordinatorState("main", {
      active: true,
      planFile,
      task: { base: "a".repeat(40), worktree: WT },
    });
    expect(
      await guardReason(
        roles,
        { tool: "subagent", sessionID: "main" },
        { prompt: "x" },
        WT,
      ),
    ).toBeNull();
  });
});

describe("appendVerdict", () => {
  test("pass appends the report; block names the child to resume; exhausted ends in failed", () => {
    expect(appendVerdict("out", { kind: "skip", status: null }, "c")).toBe(
      "out",
    );
    expect(appendVerdict("out", { kind: "pass", report: "✅" }, "c")).toBe(
      "out\n\n✅",
    );
    const blocked = appendVerdict(
      "out",
      { kind: "block", reason: "no", blocks: 1 },
      "child-1",
    );
    expect(blocked).toContain("sessionID: child-1");
    expect(blocked).toContain("subagent tool");
    expect(blocked).toContain("no");
    const done = appendVerdict(
      "out",
      { kind: "exhausted", reason: "gave up", blocks: 3 },
      null,
    );
    expect(done.trimEnd().endsWith("STATUS: failed")).toBe(true);
  });
});

describe("gateTaskOutput", () => {
  test("does not gate a running background subagent", async () => {
    expect(
      await gateTaskOutput(
        { tool: "subagent", callID: "c", args: { agent: "mimir-test" } },
        {
          output: "working",
          metadata: { status: "running", sessionID: "child" },
        },
        "/wt",
        {
          verify: async () => {
            throw new Error("must not verify running worker");
          },
          commandTimeoutMs: 1,
        },
      ),
    ).toBeNull();
  });
  test("ignores non-task tools", async () => {
    const output = { output: "x", metadata: {} };
    expect(
      await gateTaskOutput(
        { tool: "read", callID: "c", args: {} },
        output,
        "/wt",
      ),
    ).toBeNull();
    expect(output.output).toBe("x");
  });

  test("runs the gate with the child's role and id, rewrites the output", async () => {
    const seen: unknown[] = [];
    const verify = async (opts: unknown) => {
      seen.push(opts);
      return { kind: "pass", report: "✅ gate" } satisfies VerifyOutcome;
    };
    const output = {
      output: "done\n\nSTATUS: done",
      metadata: { sessionID: "child-9", status: "completed" },
    };
    const kind = await gateTaskOutput(
      {
        tool: "subagent",
        callID: "call-1",
        args: { agent: "mimir-test", prompt: "p" },
      },
      output,
      "/wt",
      { verify, commandTimeoutMs: 1 },
    );
    expect(kind).toBe("pass");
    expect(seen[0]).toMatchObject({
      role: "test",
      worktree: "/wt",
      agentId: "child-9",
    });
    expect(output.output.endsWith("✅ gate")).toBe(true);
  });
});
