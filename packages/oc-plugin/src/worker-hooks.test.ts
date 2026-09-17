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
import { writeCoordinatorState } from "@mimir/plugin-core/guard";
import type { VerifyOutcome } from "@mimir/plugin-core/verify";
import {
  appendVerdict,
  createSessionRoles,
  gateTaskOutput,
  guardReason,
  type SessionInfo,
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

describe("createSessionRoles", () => {
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

  test("secret reads denied for any session", async () => {
    const roles = rolesFor({ main: {} });
    const reason = await guardReason(
      roles,
      { tool: "read", sessionID: "main" },
      { filePath: ".env" },
      WT,
    );
    expect(reason).toContain("credentials");
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
        { tool: "task", sessionID: "main" },
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
    expect(
      await guardReason(
        roles,
        { tool: "task", sessionID: "main" },
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
    expect(blocked).toContain("task_id: child-1");
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
      metadata: { sessionId: "child-9" },
    };
    const kind = await gateTaskOutput(
      {
        tool: "task",
        callID: "call-1",
        args: { subagent_type: "mimir-test", prompt: "p" },
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
