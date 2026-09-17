import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GuardContext,
  type GuardRole,
  guardDecision,
  isSecretPath,
} from "./decision";

const WT = "/work/repo";

const ctx = (
  role: GuardRole,
  toolName: string,
  toolInput: Record<string, unknown>,
  extra: Partial<GuardContext> = {},
): GuardContext => ({ role, toolName, toolInput, worktree: WT, ...extra });

const reasonOf = (d: ReturnType<typeof guardDecision>) =>
  d.allow ? "" : d.reason;

describe("impl", () => {
  test("may edit source, may not edit tests", () => {
    expect(
      guardDecision(ctx("impl", "Edit", { file_path: "src/a.ts" })).allow,
    ).toBe(true);
    const d = guardDecision(
      ctx("impl", "Edit", { file_path: "src/a.test.ts" }),
    );
    expect(d.allow).toBe(false);
    expect(reasonOf(d)).toContain("mimir-impl");
    expect(reasonOf(d)).toContain("STATUS: blocked");
  });

  test("OpenCode-style filePath and relative paths resolve against the worktree", () => {
    expect(
      guardDecision(ctx("impl", "write", { filePath: "tests/x.py" })).allow,
    ).toBe(false);
    expect(
      guardDecision(ctx("impl", "write", { filePath: "app/x.py" })).allow,
    ).toBe(true);
  });

  test("Rust inline tests aren't a path, so lib.rs edits are allowed", () => {
    expect(
      guardDecision(ctx("impl", "Edit", { file_path: "src/lib.rs" })).allow,
    ).toBe(true);
    expect(
      guardDecision(ctx("impl", "Edit", { file_path: "tests/it.rs" })).allow,
    ).toBe(false);
  });
});

describe("test", () => {
  test("may edit tests only", () => {
    expect(
      guardDecision(ctx("test", "Write", { file_path: "pkg/a_test.go" })).allow,
    ).toBe(true);
    const d = guardDecision(ctx("test", "Write", { file_path: "pkg/a.go" }));
    expect(d.allow).toBe(false);
    expect(reasonOf(d)).toContain("mimir-test");
  });
});

describe("review", () => {
  test("no writes at all, reads fine", () => {
    expect(
      guardDecision(ctx("review", "Edit", { file_path: "src/a.ts" })).allow,
    ).toBe(false);
    expect(
      guardDecision(ctx("review", "Read", { file_path: "src/a.ts" })).allow,
    ).toBe(true);
    expect(
      guardDecision(ctx("review", "Bash", { command: "git diff" })).allow,
    ).toBe(true);
  });
});

describe("coordinator", () => {
  test("never writes", () => {
    const d = guardDecision(
      ctx("coordinator", "Write", { file_path: "src/a.ts" }),
    );
    expect(d.allow).toBe(false);
    expect(reasonOf(d)).toContain("delegates");
  });

  test("may write its own plan file and nothing else", () => {
    const extra = {
      planFile: "/work/repo/.mimir/plan.md",
      planFileExists: true,
    };
    expect(
      guardDecision(
        ctx("coordinator", "Write", { file_path: ".mimir/plan.md" }, extra),
      ).allow,
    ).toBe(true);
    expect(
      guardDecision(
        ctx("coordinator", "Edit", { file_path: "src/a.ts" }, extra),
      ).allow,
    ).toBe(false);
  });

  test("spawn is gated on the plan file", () => {
    const noPlan = guardDecision(ctx("coordinator", "Agent", { prompt: "x" }));
    expect(noPlan.allow).toBe(false);
    expect(reasonOf(noPlan)).toContain("plan file");
    expect(
      guardDecision(
        ctx("coordinator", "Agent", { prompt: "x" }, { planFileExists: true }),
      ).allow,
    ).toBe(true);
    expect(
      guardDecision(
        ctx("coordinator", "task", { prompt: "x" }, { planFileExists: false }),
      ).allow,
    ).toBe(false);
  });

  test("reads implementation inside a worker worktree are denied; tests and own files fine", () => {
    const worker = "/work/repo/.claude/worktrees/w1";
    const extra = { workerWorktrees: [worker] };
    expect(
      guardDecision(
        ctx("coordinator", "Read", { file_path: `${worker}/src/a.ts` }, extra),
      ).allow,
    ).toBe(false);
    expect(
      guardDecision(
        ctx(
          "coordinator",
          "Read",
          { file_path: `${worker}/src/a.test.ts` },
          extra,
        ),
      ).allow,
    ).toBe(true);
    expect(
      guardDecision(
        ctx("coordinator", "Read", { file_path: "src/a.ts" }, extra),
      ).allow,
    ).toBe(true);
  });
});

describe("shell safety (every role)", () => {
  const roles: GuardRole[] = ["impl", "test", "review", "coordinator"];
  for (const role of roles) {
    test(`${role}: push, reset --hard, branch -D, clean -f are denied`, () => {
      for (const command of [
        "git push origin main",
        "git -C /work/repo push --force",
        "git --no-pager -c user.name=x push",
        "cd sub && git push",
        "git reset --hard HEAD~1",
        "git branch -D feature",
        "git clean -fd",
      ]) {
        const d = guardDecision(ctx(role, "Bash", { command }));
        expect(d.allow).toBe(false);
        expect(reasonOf(d)).toContain("Role guard");
      }
    });
  }

  test("ordinary git is allowed", () => {
    for (const command of [
      "git status",
      "git diff --stat",
      "git commit -m 'x'",
      "git branch feature",
      "git reset HEAD file.ts",
      "git stash",
      "git log --grep push",
      "git commit -m 'push the button'",
      "git --no-pager diff",
    ]) {
      expect(guardDecision(ctx("impl", "Bash", { command })).allow).toBe(true);
    }
  });

  test("rm -rf inside the worktree or scratch is fine; outside is denied", () => {
    expect(
      guardDecision(ctx("impl", "Bash", { command: "rm -rf node_modules" }))
        .allow,
    ).toBe(true);
    expect(
      guardDecision(ctx("impl", "Bash", { command: "rm -rf ./dist build" }))
        .allow,
    ).toBe(true);
    expect(
      guardDecision(
        ctx("impl", "Bash", { command: `rm -rf ${join(tmpdir(), "x")}` }),
      ).allow,
    ).toBe(true);
    expect(
      guardDecision(ctx("impl", "Bash", { command: "rm -f a.txt" })).allow,
    ).toBe(true);
    for (const command of [
      "rm -rf /",
      "rm -rf ~",
      "rm -rf ../other",
      "rm -rf /work/repo",
      "rm -r /work/other/thing",
      'rm -rf "$HOME/stuff"',
      "cd src && rm -rf ../../elsewhere",
    ]) {
      const d = guardDecision(ctx("impl", "Bash", { command }));
      expect(d.allow).toBe(false);
      expect(reasonOf(d)).toContain("outside");
    }
  });

  test("OpenCode bash and ACP terminal tool names count as shell", () => {
    expect(
      guardDecision(ctx("impl", "bash", { command: "git push" })).allow,
    ).toBe(false);
    expect(
      guardDecision(ctx("impl", "terminal", { command: "git push" })).allow,
    ).toBe(false);
  });
});

describe("secrets (every role)", () => {
  test("isSecretPath", () => {
    for (const p of [
      ".env",
      ".env.local",
      "config/.env.production",
      "certs/server.pem",
      "/Users/me/.ssh/id_ed25519",
      "/Users/me/.aws/credentials",
      "credentials.json",
      ".npmrc",
    ]) {
      expect(isSecretPath(p)).toBe(true);
    }
    for (const p of [
      "src/env.ts",
      "environment.md",
      "docs/.envrc-example.md",
      "pem-parser.ts",
    ]) {
      expect(isSecretPath(p)).toBe(false);
    }
  });

  test("reads and writes of secret paths are denied for every role", () => {
    for (const role of ["impl", "test", "review", "coordinator"] as const) {
      expect(
        guardDecision(ctx(role, "Read", { file_path: ".env" })).allow,
      ).toBe(false);
      expect(
        guardDecision(ctx(role, "read", { filePath: "~/.aws/credentials" }))
          .allow,
      ).toBe(false);
      expect(
        guardDecision(ctx(role, "Write", { file_path: ".env.local" })).allow,
      ).toBe(false);
    }
  });
});

describe("everything else passes", () => {
  test("unrelated tools are allowed for every role", () => {
    for (const role of ["impl", "test", "review", "coordinator"] as const) {
      expect(guardDecision(ctx(role, "Grep", { pattern: "x" })).allow).toBe(
        true,
      );
      expect(guardDecision(ctx(role, "mcp__foo__bar", {})).allow).toBe(true);
    }
  });
});
