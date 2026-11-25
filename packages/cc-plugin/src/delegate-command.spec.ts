import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  describeState,
  formatWorkerModels,
  parseDelegateArgs,
  parseReviewPromptArgs,
  runDelegateCommand,
  SESSION_ENV,
} from "./delegate-command";

describe("parseDelegateArgs", () => {
  test("start requires --plan and resolves it", () => {
    expect(parseDelegateArgs(["start", "--plan", "docs/plan.md"])).toEqual({
      action: "start",
      planFile: resolve("docs/plan.md"),
    });
    expect(typeof parseDelegateArgs(["start"])).toBe("string");
  });

  test("status and stop take no arguments; anything else is usage", () => {
    expect(parseDelegateArgs(["status"])).toEqual({ action: "status" });
    expect(parseDelegateArgs(["stop"])).toEqual({ action: "stop" });
    expect(typeof parseDelegateArgs([])).toBe("string");
    expect(typeof parseDelegateArgs(["pause"])).toBe("string");
  });
});

describe("parseReviewPromptArgs", () => {
  test("worktree positional, optional title, flag order agnostic", () => {
    expect(parseReviewPromptArgs(["/wt"])).toEqual({
      worktree: "/wt",
      title: "Review this change",
    });
    expect(parseReviewPromptArgs(["--title", "Add shout", "/wt"])).toEqual({
      worktree: "/wt",
      title: "Add shout",
    });
    expect(parseReviewPromptArgs(["/wt", "--title", "Add shout"])).toEqual({
      worktree: "/wt",
      title: "Add shout",
    });
    expect(parseReviewPromptArgs(["--title", "only"])).toBeNull();
  });
});

describe("formatWorkerModels", () => {
  test("lists set roles in impl, test, review order", () => {
    expect(
      formatWorkerModels({ impl: "opus", test: "sonnet", review: "fable" }),
    ).toBe("worker models: impl=opus test=sonnet review=fable");
  });

  test("declaration order does not change the reported order", () => {
    expect(
      formatWorkerModels({ review: "fable", impl: "opus", test: "sonnet" }),
    ).toBe("worker models: impl=opus test=sonnet review=fable");
  });

  test("omits unset roles", () => {
    expect(formatWorkerModels({ review: "fable" })).toBe(
      "worker models: review=fable",
    );
    expect(formatWorkerModels({ impl: "opus", review: "fable" })).toBe(
      "worker models: impl=opus review=fable",
    );
  });

  test("no overrides reads as the default", () => {
    expect(formatWorkerModels({})).toBe(
      "worker models: default (same model for every role)",
    );
  });
});

describe("describeState", () => {
  test("an existing plan file reports session, plan, models — and no warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mimir-delegate-"));
    const planFile = join(dir, "plan.md");
    await Bun.write(planFile, "# plan\n");

    const lines = (
      await describeState("sess-1", planFile, { impl: "opus", test: "sonnet" })
    ).split("\n");

    expect(lines).toEqual([
      "delegation active for session sess-1",
      `plan: ${planFile}`,
      "worker models: impl=opus test=sonnet",
    ]);
  });

  test("a missing plan file appends the warning after the models line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mimir-delegate-"));
    const planFile = join(dir, "absent.md");

    const lines = (await describeState("sess-2", planFile, {})).split("\n");

    expect(lines).toEqual([
      "delegation active for session sess-2",
      `plan: ${planFile}`,
      "worker models: default (same model for every role)",
      "plan file not written yet — workers cannot be spawned until it exists",
    ]);
  });
});

describe("runDelegateCommand reports the claudeCode namespace", () => {
  let previousMimirHome: string | undefined;
  let previousSession: string | undefined;
  let sandbox: string;

  beforeEach(() => {
    previousMimirHome = process.env.MIMIR_HOME;
    previousSession = process.env[SESSION_ENV];
    sandbox = mkdtempSync(join(tmpdir(), "mimir-delegate-host-"));
    process.env.MIMIR_HOME = sandbox;
    process.env[SESSION_ENV] = "sess-claude-code";
  });

  afterEach(() => {
    if (previousMimirHome === undefined) delete process.env.MIMIR_HOME;
    else process.env.MIMIR_HOME = previousMimirHome;
    if (previousSession === undefined) delete process.env[SESSION_ENV];
    else process.env[SESSION_ENV] = previousSession;
    rmSync(sandbox, { recursive: true, force: true });
  });

  test("start reads the claudeCode models, never another host's", async () => {
    await Bun.write(
      join(sandbox, "config.json"),
      `${JSON.stringify({
        serverUrl: "https://mimir.example.com",
        userMemoryDb: join(sandbox, "user-memories.db"),
        workerModels: {
          claudeCode: { impl: "opus" },
          opencode: { impl: "anthropic/claude-opus-4" },
        },
      })}\n`,
    );
    const planFile = join(sandbox, "plan.md");
    await Bun.write(planFile, "# plan\n");

    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.join(" "));
    };
    let code: number;
    try {
      code = await runDelegateCommand(["start", "--plan", planFile]);
    } finally {
      console.log = realLog;
    }

    const output = logged.join("\n");
    expect(code).toBe(0);
    expect(output).toContain("worker models: impl=opus");
    expect(output).not.toContain("anthropic/claude-opus-4");

    await runDelegateCommand(["stop"]);
  });

  test("mimir.toml [workers.models.claudeCode] overrides config.json: user layer, then the project's", async () => {
    await Bun.write(
      join(sandbox, "config.json"),
      `${JSON.stringify({
        serverUrl: "https://mimir.example.com",
        userMemoryDb: join(sandbox, "user-memories.db"),
        workerModels: { claudeCode: { impl: "opus", test: "opus" } },
      })}\n`,
    );
    // MIMIR_HOME is the sandbox, so this is the user layer.
    await Bun.write(
      join(sandbox, "mimir.toml"),
      '[workers.models.claudeCode]\ntest = "sonnet"\n',
    );
    const project = join(sandbox, "project");
    mkdirSync(project, { recursive: true });
    await Bun.write(
      join(project, "mimir.toml"),
      '[workers.models.claudeCode]\nreview = "haiku"\n',
    );
    const planFile = join(project, "plan.md");
    await Bun.write(planFile, "# plan\n");

    const logged: string[] = [];
    const realLog = console.log;
    const realCwd = process.cwd();
    console.log = (...args: unknown[]) => {
      logged.push(args.join(" "));
    };
    let code: number;
    try {
      process.chdir(project);
      code = await runDelegateCommand(["start", "--plan", planFile]);
    } finally {
      console.log = realLog;
      process.chdir(realCwd);
    }

    expect(code).toBe(0);
    expect(logged.join("\n")).toContain(
      "worker models: impl=opus test=sonnet review=haiku",
    );

    await runDelegateCommand(["stop"]);
  });
});

// Repository-relative test files the coordinator allows to be deleted.
// Neither is a substring of the other.
const FIRST = "pkg/first.spec.ts";
const SECOND = "pkg/second.spec.ts";

describe("parseDelegateArgs allow-deletion", () => {
  test("takes one or more paths; none is a usage error", () => {
    expect(parseDelegateArgs(["allow-deletion", FIRST, SECOND])).toEqual({
      action: "allow-deletion",
      paths: [FIRST, SECOND],
    });
    expect(typeof parseDelegateArgs(["allow-deletion"])).toBe("string");
  });
});

describe("delegate allow-deletion", () => {
  let previousMimirHome: string | undefined;
  let previousSession: string | undefined;
  let realCwd: string;
  let sandbox: string;
  let planFile: string;

  /** runDelegateCommand with its console output captured. */
  const delegate = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const realLog = console.log;
    const realError = console.error;
    console.log = (...parts: unknown[]) => {
      out.push(parts.join(" "));
    };
    console.error = (...parts: unknown[]) => {
      err.push(parts.join(" "));
    };
    try {
      const code = await runDelegateCommand(args);
      return { code, stdout: out.join("\n"), stderr: err.join("\n") };
    } finally {
      console.log = realLog;
      console.error = realError;
    }
  };

  const status = async () => (await delegate("status")).stdout;

  const startTask = async (plan = planFile) => {
    expect((await delegate("start", "--plan", plan)).code).toBe(0);
    const task = await delegate("task");
    expect(task.code, task.stderr).toBe(0);
  };

  beforeEach(async () => {
    previousMimirHome = process.env.MIMIR_HOME;
    previousSession = process.env[SESSION_ENV];
    realCwd = process.cwd();
    sandbox = mkdtempSync(join(tmpdir(), "mimir-delegate-allow-"));
    process.env.MIMIR_HOME = join(sandbox, "home");
    process.env[SESSION_ENV] = "sess-allow-deletion";
    const repo = join(sandbox, "repo");
    mkdirSync(repo, { recursive: true });
    // `delegate task` captures HEAD of the repository it runs in.
    for (const argv of [
      ["git", "init", "-q", "-b", "main"],
      [
        "git",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "user.name=Fixture",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "baseline",
      ],
    ]) {
      const result = Bun.spawnSync(argv, { cwd: repo });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    }
    planFile = join(repo, "plan.md");
    await Bun.write(planFile, "# plan\n");
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(realCwd);
    if (previousMimirHome === undefined) delete process.env.MIMIR_HOME;
    else process.env.MIMIR_HOME = previousMimirHome;
    if (previousSession === undefined) delete process.env[SESSION_ENV];
    else process.env[SESSION_ENV] = previousSession;
    rmSync(sandbox, { recursive: true, force: true });
  });

  test("records the paths for the current task, adds on a second call, and status shows them", async () => {
    await startTask();

    const first = await delegate("allow-deletion", FIRST);
    expect(first.code, first.stderr).toBe(0);
    expect(await status()).toContain(FIRST);
    expect(await status()).not.toContain(SECOND);

    const second = await delegate("allow-deletion", SECOND);
    expect(second.code, second.stderr).toBe(0);
    const shown = await status();
    expect(shown).toContain(FIRST);
    expect(shown).toContain(SECOND);
  });

  test("several paths in one call are all recorded", async () => {
    await startTask();

    expect((await delegate("allow-deletion", FIRST, SECOND)).code).toBe(0);
    const shown = await status();
    expect(shown).toContain(FIRST);
    expect(shown).toContain(SECOND);
  });

  test("capturing the next task allows nothing", async () => {
    await startTask();
    expect((await delegate("allow-deletion", FIRST)).code).toBe(0);

    expect((await delegate("task")).code).toBe(0);
    expect(await status()).not.toContain(FIRST);
  });

  test("starting a different plan allows nothing", async () => {
    await startTask();
    expect((await delegate("allow-deletion", FIRST)).code).toBe(0);

    const nextPlan = join(sandbox, "repo", "next-plan.md");
    await Bun.write(nextPlan, "# next plan\n");
    await startTask(nextPlan);
    expect(await status()).not.toContain(FIRST);
  });

  test("stop allows nothing, including after the delegation starts again", async () => {
    await startTask();
    expect((await delegate("allow-deletion", FIRST)).code).toBe(0);

    expect((await delegate("stop")).code).toBe(0);
    expect(await status()).not.toContain(FIRST);
    await startTask();
    expect(await status()).not.toContain(FIRST);
  });

  test("no path: records nothing, exits non-zero and says what is missing", async () => {
    await startTask();

    const refused = await delegate("allow-deletion");
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("allow-deletion");
  });

  test("no active delegation: records nothing, exits non-zero and says so", async () => {
    const refused = await delegate("allow-deletion", FIRST);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("active delegation");

    await startTask();
    expect(await status()).not.toContain(FIRST);
  });

  test("a delegation without a task boundary: records nothing, exits non-zero and names delegate task", async () => {
    expect((await delegate("start", "--plan", planFile)).code).toBe(0);

    const refused = await delegate("allow-deletion", FIRST);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("delegate task");
    expect(await status()).not.toContain(FIRST);

    expect((await delegate("task")).code).toBe(0);
    expect(await status()).not.toContain(FIRST);
  });
});
