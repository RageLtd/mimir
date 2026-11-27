import { describe, expect, test } from "bun:test";
import { type GuardRole, guardDecision } from "./decision";

const WT = "/work/repo";
const WORKERS = ["impl", "test", "review"] satisfies GuardRole[];

const shell = (role: GuardRole, command: string) =>
  guardDecision({
    role,
    toolName: "Bash",
    toolInput: { command },
    worktree: WT,
  });

const reasonOf = (d: ReturnType<typeof guardDecision>) =>
  d.allow ? "" : d.reason;

const expectAllowed = (role: GuardRole, commands: readonly string[]) => {
  for (const command of commands) {
    expect({ command, allow: shell(role, command).allow }).toEqual({
      command,
      allow: true,
    });
  }
};

describe("a worker gets no git at all", () => {
  const gitLines = [
    "git status",
    "git diff",
    "git diff --stat HEAD",
    "git log --oneline -5",
    "git add a.ts",
    "git stash",
    "git commit -m 'x'",
    "git commit --amend --no-edit",
    "git -C /work/repo status",
    "git --no-pager diff",
    "git branch --list",
    "git update-ref refs/heads/main HEAD",
    "git branch -f main HEAD~1",
    "cd sub && git status",
    "bun test >| /tmp/log.txt; git diff",
    "ls src | git hash-object --stdin",
    'grep -rn "git commit" src/',
  ];

  const notGit = ["cat .gitignore", "ls .github/workflows", "grep digit src/"];

  for (const role of WORKERS) {
    test(`${role}: any command line that runs or names git is refused`, () => {
      for (const command of gitLines) {
        const d = shell(role, command);
        expect({ command, allow: d.allow }).toEqual({ command, allow: false });
        expect(reasonOf(d)).toContain("Role guard");
      }
    });

    test(`${role}: the refusal says workers do not use git, the change stays uncommitted for the coordinator, and files are read directly`, () => {
      for (const command of ["git status", "git diff", "git commit -m x"]) {
        const reason = reasonOf(shell(role, command));
        expect(reason).toMatch(/(?:do(?:es)? not|never|don't) use git/i);
        expect(reason).toMatch(/uncommitted/i);
        expect(reason).toMatch(/worktree/i);
        expect(reason).toMatch(/coordinator/i);
        expect(reason).toMatch(/read(?:s|ing)? (?:the |its )?files/i);
      }
    });

    test(`${role}: names that only contain the letters are not git`, () => {
      expectAllowed(role, notGit);
    });
  }

  test("the coordinator may run git as before", () => {
    expectAllowed("coordinator", [...gitLines, ...notGit]);
  });
});

describe("delegate task, allow-removal and allow-deletion fail closed for a worker", () => {
  const TASK = /starting a task is the coordinator's call/i;
  const REMOVAL = /lose assertions/i;
  const DELETION = /test-file deletion/i;

  const invocations: readonly (readonly [string, RegExp])[] = [
    ["mimir-cc delegate task", TASK],
    ["mimir-cc delegate allow-removal src/a.test.ts", REMOVAL],
    ["mimir-cc delegate allow-deletion src/a.test.ts", DELETION],
    ["~/.local/bin/mimir-cc delegate task --refactor", TASK],
    ["/Users/me/.local/bin/mimir-cc delegate allow-removal a_test.go", REMOVAL],
    ["bun packages/cc-plugin/src/cli.ts delegate task", TASK],
    [
      "bun /work/repo/packages/cc-plugin/src/cli.ts delegate allow-removal a.test.ts",
      REMOVAL,
    ],
    [
      "bun packages/cc-plugin/src/cli.ts delegate allow-deletion a_test.go",
      DELETION,
    ],
    ["bun run packages/cc-plugin/src/cli.ts delegate task", TASK],
    ["cd /work/repo && mimir-cc delegate task", TASK],
    ["ls; mimir-cc delegate allow-removal a.test.ts", REMOVAL],
    ["true || bun ./cli.ts delegate allow-removal a.test.ts", REMOVAL],
    ["CLAUDE_CODE_SESSION_ID=abc mimir-cc delegate task", TASK],
    ["env mimir-cc delegate allow-removal a.test.ts", REMOVAL],
    ["(mimir-cc delegate task)", TASK],
    ['sh -c "mimir-cc delegate task"', TASK],
    ["echo $(mimir-cc delegate task)", TASK],
    ["echo src/a.test.ts | xargs mimir-cc delegate allow-deletion", DELETION],
    ['echo "run mimir-cc delegate task"', TASK],
    ["echo 'mimir-cc delegate allow-removal a.test.ts'", REMOVAL],
  ];

  const mentions = [
    'grep -rn "delegate task" packages/',
    "rg 'delegate allow-removal'",
    "rg -n 'delegate task|delegate allow-removal' packages/plugin-core/src",
    'grep -rn "delegate allow-deletion" packages/',
    "cat docs/delegate-task.md",
  ];

  for (const role of WORKERS) {
    test(`${role}: the program name followed by the subcommand is refused anywhere in the line`, () => {
      for (const [command, reason] of invocations) {
        const d = shell(role, command);
        expect({ command, allow: d.allow }).toEqual({ command, allow: false });
        expect({ command, reason: reasonOf(d) }).toEqual({
          command,
          reason: expect.stringMatching(reason),
        });
      }
    });

    test(`${role}: a command that only mentions the subcommand words is allowed`, () => {
      expectAllowed(role, mentions);
    });
  }

  test("the coordinator is unaffected", () => {
    expectAllowed("coordinator", [
      ...invocations.map(([command]) => command),
      ...mentions,
    ]);
  });
});
