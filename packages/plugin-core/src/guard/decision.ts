/**
 * Role guard — what an agent in a given role may do with a tool call.
 *
 * Pure: the host adapter builds a `GuardContext` from its native tool
 * event (plus whatever state the coordinator role needs) and maps the
 * decision back into its permission protocol. No filesystem, no host
 * knowledge here.
 *
 * Roles:
 *   impl         — may not write test files (it can't make tests pass by
 *                  editing them)
 *   test         — may only write test files
 *   review       — may not write at all
 *   coordinator  — active only while a delegation is in flight: may not
 *                  write, may not spawn a worker until the plan file
 *                  exists, may not read implementation files inside a
 *                  worker's worktree (its context stays strategic)
 *
 * Every role: no `git push`, no destructive git, no `rm -rf` outside the
 * agent's own worktree, no reads or writes of secret material.
 */

import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { eventMatchesTool } from "../rules/runner";
import { isTestFile } from "../rules/test-conventions";
import { expandHomePath } from "../util";

export type GuardRole = "impl" | "test" | "review" | "coordinator";

export const GUARD_ROLES: readonly GuardRole[] = [
  "impl",
  "test",
  "review",
  "coordinator",
];

// Inferred type predicate — the literal comparisons narrow `value`.
export const isGuardRole = (value: unknown) =>
  value === "impl" ||
  value === "test" ||
  value === "review" ||
  value === "coordinator";

export type GuardContext = {
  readonly role: GuardRole;
  /** Host-native tool name (`Edit`, `Bash`, `read`, `task`, …). */
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  /** The directory this agent owns — its worktree, else the project root. */
  readonly worktree: string;
  /** Coordinator only: the session's plan file is on disk. */
  readonly planFileExists?: boolean;
  /** Coordinator only: worker worktree roots it must not read source from. */
  readonly workerWorktrees?: readonly string[];
};

export type GuardDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

const allow = { allow: true } as const;
const deny = (reason: string) => ({ allow: false, reason }) as const;

// ── Tool classes across hosts ──

const READ_TOOLS: ReadonlySet<string> = new Set([
  "Read", // Claude Code, Codex
  "read", // OpenCode
  "fs_read_text_file", // ACP
  "read_text_file", // ACP
]);

const SPAWN_TOOLS: ReadonlySet<string> = new Set([
  "Agent", // Claude Code
  "Task", // Claude Code alias
  "task", // OpenCode
]);

const isWrite = (toolName: string) => eventMatchesTool("file", toolName);
const isShell = (toolName: string) => eventMatchesTool("bash", toolName);

// ── Paths ──

/** The file a tool call targets, resolved against the agent's worktree. */
const targetPath = (ctx: GuardContext) => {
  const raw =
    ctx.toolInput.file_path ?? ctx.toolInput.filePath ?? ctx.toolInput.path;
  if (typeof raw !== "string" || raw.length === 0) return null;
  return resolve(ctx.worktree, expandHomePath(raw));
};

const isInside = (filePath: string, root: string) => {
  const r = resolve(root);
  return filePath === r || filePath.startsWith(r + sep);
};

/**
 * Paths that hold credentials. Mirrors the `Read(...)` deny rules the
 * installer writes for Claude Code so every host refuses the same set.
 */
export const SECRET_PATH =
  /(?:^|\/)\.env(?:\.[^/]*)?$|\.pem$|\.p12$|\.pfx$|(?:^|\/)id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?$|(?:^|\/)credentials(?:\.[^/]*)?$|(?:^|\/)\.aws\/|(?:^|\/)\.ssh\/|(?:^|\/)\.netrc$|(?:^|\/)\.npmrc$|(?:^|\/)\.pypirc$/;

export const isSecretPath = (filePath: string) =>
  SECRET_PATH.test(filePath.split(sep).join("/"));

/**
 * The same set as host permission wildcards (`*` matches across `/`),
 * for hosts with a native read-permission layer.
 */
export const SECRET_PATH_GLOBS: readonly string[] = [
  "*.env",
  "*.env.*",
  "*.pem",
  "*.p12",
  "*.pfx",
  "*/.ssh/*",
  "*/.aws/*",
  "*credentials",
  "*credentials.*",
  "*.netrc",
  "*.npmrc",
  "*.pypirc",
  "*id_rsa*",
  "*id_ed25519*",
  "*id_ecdsa*",
];

// ── Shell safety (every role) ──

/**
 * `git`, then any global options before the subcommand — a bare flag
 * (`--no-pager`), or a flag with a value (`-C /path`, `-c k=v`).
 */
const GIT = String.raw`\bgit\s+(?:-\S+\s+(?:[^-\s;&|][^\s;&|]*\s+)?)*`;
const GIT_PUSH = new RegExp(`${GIT}push\\b`);
const GIT_RESET_HARD = new RegExp(`${GIT}reset\\b[^;&|]*--hard\\b`);
const GIT_BRANCH_DELETE = new RegExp(`${GIT}branch\\b[^;&|]*\\s-[a-zA-Z]*D\\b`);
const GIT_CLEAN_FORCE = new RegExp(`${GIT}clean\\b[^;&|]*\\s-[a-zA-Z]*f`);
const RM_RECURSIVE = /\brm\s+((?:-\S+\s+)+)([^;&|]*)/g;

const stripQuotes = (word: string) => word.replace(/^['"]|['"]$/g, "");

/** `rm -r` targets that escape the worktree (scratch dirs are fine). */
const rmEscapes = (command: string, worktree: string) => {
  const scratch = [tmpdir(), "/tmp", "/private/tmp"];
  for (const match of command.matchAll(RM_RECURSIVE)) {
    const flags = match[1] ?? "";
    if (!/(?:^|\s)-[a-zA-Z]*[rR]|--recursive/.test(flags)) continue;
    for (const word of (match[2] ?? "").trim().split(/\s+/)) {
      if (!word) continue;
      const raw = stripQuotes(word);
      if (raw.includes("$") || raw === "/" || raw === "~" || raw === "~/") {
        return raw;
      }
      const abs = resolve(worktree, expandHomePath(raw));
      const insideWorktree =
        abs !== resolve(worktree) && isInside(abs, worktree);
      const inScratch = scratch.some((s) => isInside(abs, s));
      if (!insideWorktree && !inScratch) return raw;
    }
  }
  return null;
};

const shellDecision = (command: string, worktree: string) => {
  if (GIT_PUSH.test(command)) {
    return deny(
      "Role guard: agents never push. Leave the branch for the coordinator and the developer to publish.",
    );
  }
  if (GIT_RESET_HARD.test(command)) {
    return deny(
      "Role guard: `git reset --hard` discards work that nobody reviewed. Use `git stash` or a new branch.",
    );
  }
  if (GIT_BRANCH_DELETE.test(command)) {
    return deny("Role guard: agents don't delete branches (`git branch -D`).");
  }
  if (GIT_CLEAN_FORCE.test(command)) {
    return deny(
      "Role guard: `git clean -f` deletes untracked files nobody reviewed. List them instead and report.",
    );
  }
  const escaped = rmEscapes(command, worktree);
  if (escaped !== null) {
    return deny(
      `Role guard: recursive delete of \`${escaped}\` reaches outside this agent's worktree (${worktree}). Delete only inside the worktree or under the system temp dir.`,
    );
  }
  return allow;
};

// ── Role rules ──

const workerWriteDecision = (ctx: GuardContext, path: string | null) => {
  switch (ctx.role) {
    case "impl":
      return path !== null && isTestFile(path)
        ? deny(
            `Role guard: mimir-impl may not modify test files (${path}). Finish with STATUS: blocked and tell the coordinator what test change is needed.`,
          )
        : allow;
    case "test":
      return path !== null && !isTestFile(path)
        ? deny(
            `Role guard: mimir-test may only modify test files, not ${path}. Finish with STATUS: blocked and describe the implementation change you need.`,
          )
        : allow;
    case "review":
      return deny(
        "Role guard: mimir-review is read-only. Report findings in your final message instead of editing.",
      );
    case "coordinator":
      return deny(
        "Role guard: the coordinator delegates, it does not implement. Spawn a worker for this change.",
      );
    default:
      return assertNever(ctx.role);
  }
};

const assertNever = (value: never) => {
  throw new Error(`Unhandled guard role: ${String(value)}`);
};

const coordinatorDecision = (ctx: GuardContext, path: string | null) => {
  if (SPAWN_TOOLS.has(ctx.toolName) && ctx.planFileExists !== true) {
    return deny(
      "Role guard: no plan file for this delegation yet. Write the plan first (Make Plan → Act is a gate, not a suggestion), then spawn workers.",
    );
  }
  if (READ_TOOLS.has(ctx.toolName) && path !== null && !isTestFile(path)) {
    const inWorker = (ctx.workerWorktrees ?? []).some((root) =>
      isInside(path, root),
    );
    if (inWorker) {
      return deny(
        `Role guard: the coordinator reads the gate report and the added tests, not worker implementation (${path}). Ask the worker or the reviewer instead.`,
      );
    }
  }
  return allow;
};

/** Decide one tool call for one role. */
export const guardDecision = (ctx: GuardContext) => {
  const path = targetPath(ctx);

  if (
    path !== null &&
    (isWrite(ctx.toolName) || READ_TOOLS.has(ctx.toolName))
  ) {
    if (isSecretPath(path)) {
      return deny(
        `Role guard: ${path} holds credentials. Agents never read or write secret material.`,
      );
    }
  }

  if (isShell(ctx.toolName)) {
    const command = ctx.toolInput.command;
    if (typeof command === "string") {
      const verdict = shellDecision(command, ctx.worktree);
      if (!verdict.allow) return verdict;
    }
  }

  if (isWrite(ctx.toolName)) {
    const verdict = workerWriteDecision(ctx, path);
    if (!verdict.allow) return verdict;
  }

  if (ctx.role === "coordinator") return coordinatorDecision(ctx, path);
  return allow;
};
