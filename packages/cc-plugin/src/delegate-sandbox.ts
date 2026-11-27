/**
 * Spec support for the delegate commands and the gate entry: a session, a
 * Mimir home and a project directory per test, with git canned. Nothing
 * here runs a command.
 */

import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "@mimir/plugin-core/verify";
import {
  type CannedAnswer,
  cannedGit,
} from "@mimir/plugin-core/verify/testing";
import { runDelegateCommand, SESSION_ENV } from "./delegate-command";

export const HEAD = "c".repeat(40);
export const NEXT_HEAD = "d".repeat(40);

/** A command's exit code with what it printed. */
export const captured = (command: () => Promise<number>) => {
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
  return command()
    .then((code) => ({
      code,
      stdout: out.join("\n"),
      stderr: err.join("\n"),
    }))
    .finally(() => {
      console.log = realLog;
      console.error = realError;
    });
};

/**
 * A fresh session for each test, working in a project directory that is a
 * repository only as far as canned git says: `delegate task` is told that
 * HEAD is the sandbox's current head and that the directory is its own top
 * level. Call once at the top of a spec file.
 */
export const delegateSandbox = (session: string) => {
  const saved = {
    home: process.env.MIMIR_HOME,
    session: process.env[SESSION_ENV],
    cwd: process.cwd(),
  };
  const state = { root: "", repo: "", head: HEAD };

  beforeEach(() => {
    state.root = realpathSync(mkdtempSync(join(tmpdir(), "mimir-delegate-")));
    state.repo = join(state.root, "repo");
    state.head = HEAD;
    // The provenance check resolves the repository's git directory on disk.
    mkdirSync(join(state.repo, ".git"), { recursive: true });
    process.env.MIMIR_HOME = join(state.root, "home");
    process.env[SESSION_ENV] = session;
    process.chdir(state.repo);
  });

  afterEach(() => {
    process.chdir(saved.cwd);
    if (saved.home === undefined) delete process.env.MIMIR_HOME;
    else process.env.MIMIR_HOME = saved.home;
    if (saved.session === undefined) delete process.env[SESSION_ENV];
    else process.env[SESSION_ENV] = saved.session;
    rmSync(state.root, { recursive: true, force: true });
  });

  /** Git as `delegate task` asks it, in the project directory. */
  const git = () =>
    cannedGit({
      "rev-parse --verify HEAD": `${state.head}\n`,
      "rev-parse --show-toplevel": `${state.repo}\n`,
    });

  return {
    /** The project directory, with symlinks resolved. */
    repo: () => state.repo,
    /** The directory holding the project directory. */
    root: () => state.root,
    /** What canned git reports as HEAD from now on. */
    moveHead: (head: string) => {
      state.head = head;
    },
    /** A worker's worktree directory, where Claude Code puts it. */
    addWorker: (agentId: string) => {
      const path = join(state.repo, ".claude", "worktrees", `agent-${agentId}`);
      mkdirSync(path, { recursive: true });
      return path;
    },
    /**
     * Git as the gate entry and the provenance check ask it, for `worker`
     * as a linked worktree of the project. `extra` answers win.
     */
    worktreeGit: (worker: string, extra: Record<string, CannedAnswer> = {}) =>
      cannedGit({
        "rev-parse --verify HEAD": `${state.head}\n`,
        [`${state.repo}$ rev-parse --show-toplevel`]: `${state.repo}\n`,
        [`${worker}$ rev-parse --show-toplevel`]: `${worker}\n`,
        [`${state.repo}$ rev-parse --git-common-dir`]: ".git\n",
        [`${worker}$ rev-parse --git-common-dir`]: `${join(state.repo, ".git")}\n`,
        [`merge-base --is-ancestor ${state.head} HEAD`]: "",
        ...extra,
      }),
    delegate: (...args: string[]) =>
      captured(() => runDelegateCommand(args, git())),
    /** The same command with git answering as `run` says. */
    delegateWith: (run: CommandRunner, ...args: string[]) =>
      captured(() => runDelegateCommand(args, run)),
  };
};
