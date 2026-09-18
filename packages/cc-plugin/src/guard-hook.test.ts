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
import {
  buildGuardContext,
  guardOutput,
  parseGuardArgs,
  parseWorktreeList,
  roleFromInput,
} from "./guard-hook";

describe("parseGuardArgs", () => {
  test("accepts the four roles, rejects the rest", () => {
    expect(parseGuardArgs(["--role", "impl"])).toBe("impl");
    expect(parseGuardArgs(["--role", "coordinator"])).toBe("coordinator");
    expect(parseGuardArgs(["--role", "boss"])).toBeNull();
    expect(parseGuardArgs([])).toBeNull();
  });
});

describe("roleFromInput", () => {
  test("worker agent_type → its role; none → coordinator; other → null", () => {
    expect(roleFromInput({ agent_type: "mimir-impl" })).toBe("impl");
    expect(roleFromInput({ agent_type: "mimir-test" })).toBe("test");
    expect(roleFromInput({ agent_type: "mimir-review" })).toBe("review");
    // Plugin-shipped agents arrive as `<plugin>:<name>` in the payload.
    expect(roleFromInput({ agent_type: "mimir-cc:mimir-test" })).toBe("test");
    expect(roleFromInput({})).toBe("coordinator");
    expect(roleFromInput({ agent_type: "Explore" })).toBeNull();
  });
});

describe("parseWorktreeList", () => {
  test("drops the coordinator's own worktree", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /repo/.claude/worktrees/w1",
      "HEAD def",
      "branch refs/heads/w1",
      "",
    ].join("\n");
    expect(parseWorktreeList(porcelain, "/repo")).toEqual([
      "/repo/.claude/worktrees/w1",
    ]);
  });
});

describe("guardOutput", () => {
  test("allow → null; deny → PreToolUse deny with the reason", () => {
    expect(guardOutput({ allow: true })).toBeNull();
    expect(guardOutput({ allow: false, reason: "nope" })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "nope",
      },
    });
  });
});

describe("buildGuardContext", () => {
  const dirs: string[] = [];
  const savedHome = process.env.MIMIR_HOME;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "mimir-guard-"));
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

  test("worker roles: worktree is cwd, no coordinator fields", async () => {
    const ctx = await buildGuardContext("impl", {
      tool_name: "Edit",
      tool_input: { file_path: "a.ts" },
      cwd: "/wt",
    });
    expect(ctx).toEqual({
      role: "impl",
      toolName: "Edit",
      toolInput: { file_path: "a.ts" },
      worktree: "/wt",
    });
  });

  test("no tool name → null", async () => {
    expect(await buildGuardContext("impl", {})).toBeNull();
  });

  test("coordinator: silent without active state, populated with it", async () => {
    const input = {
      session_id: "s",
      tool_name: "Agent",
      tool_input: { prompt: "x" },
      cwd: dirs[0] ?? "/",
    };
    expect(await buildGuardContext("coordinator", input)).toBeNull();

    const planFile = join(dirs[0] ?? "", "plan.md");
    await writeCoordinatorState("s", { active: true, planFile });
    const before = await buildGuardContext("coordinator", input);
    expect(before?.planFileExists).toBe(false);
    expect(before?.workerWorktrees).toEqual([]);

    await Bun.write(planFile, "# plan\n");
    const after = await buildGuardContext("coordinator", input);
    expect(after?.planFileExists).toBe(true);
  });
});
