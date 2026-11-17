/**
 * Shared fixtures for the tool-hook kit tests: a session with the
 * binary's path, and the shapes `$.process.run` answers with.
 */

import type { On } from "claude-code";
import { mock } from "claude-code/testing";

export const HOME = "/home/t";
export const BIN = `${HOME}/.local/bin/mimir-cc`;
export const SESSION = "sess-1";
export const CWD = "/work/repo";

/**
 * A binary run as its subcommand takes it: `argv` without the payload flag,
 * and `payload` the text of the file that flag named.
 */
export type Run = { argv: readonly string[]; payload?: string; env?: object };

const PAYLOAD_FLAG = "--payload";

/** The payload files the module wrote (`$.fs.write`), by path. */
export const payloads = (on: On) => {
  const written = new Map<string, string>();
  on("fs.write", (_, e) => {
    written.set(e.path, e.text);
    return { value: undefined };
  });
  return written;
};

/** One `process.run` as a Run, its payload read back from `written`. */
export const asRun = (
  written: ReadonlyMap<string, string>,
  e: {
    readonly argv: readonly string[];
    readonly init?: { readonly env?: object };
  },
) => {
  const at = e.argv.indexOf(PAYLOAD_FLAG);
  return {
    argv: at === -1 ? e.argv : e.argv.filter((_, i) => i < at || i > at + 1),
    payload: at === -1 ? undefined : written.get(e.argv[at + 1] ?? ""),
    env: e.init?.env,
  } satisfies Run;
};

export const exited = (exitCode: number, stdout = "") => ({
  value: {
    exitCode,
    stdout,
    stderr: "",
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
});

/** A PreToolUse deny as the tool subcommands print it. */
export const denied = (reason: string) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });

/** A PreToolUse nudge / injection as the tool subcommands print it. */
export const nudged = (context: string, message?: string) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: context,
    },
    ...(message === undefined ? {} : { systemMessage: message }),
  });

export const BASH_RESULT = { stdout: "ok", stderr: "", interrupted: false };

/** `$.store` over a map the test holds, so it can read what was kept. */
const store = (on: On, kept: Map<string, unknown>) => {
  on("store.get", (_, e) => ({ value: kept.get(e.key) }));
  on("store.set", (_, e) => {
    kept.set(e.key, e.value);
    return { value: undefined };
  });
  on("store.delete", (_, e) => {
    kept.delete(e.key);
    return { value: undefined };
  });
  on("store.keys", () => ({ value: [...kept.keys()] }));
};

/** Where `session` keeps the `reanchor` state flag, in the map it is given. */
export const REANCHOR = "state:reanchor";

/**
 * The session every tool-hook test runs in; returns the status lines
 * shown. `kept` is the plugin's store: pass a map to seed it or read it.
 * It also holds the `reanchor` state flag, under REANCHOR.
 */
export const session = (
  on: On,
  env: Record<string, string> = {},
  kept: Map<string, unknown> = new Map(),
) => {
  mock.env(on, { HOME, ...env });
  store(on, kept);
  on("session.id", () => ({ value: SESSION }));
  on("session.cwd", () => ({ value: CWD }));
  on("agent.list", () => ({ value: [] }));
  on("state.get", { key: "reanchor" }, () => ({
    value: { value: kept.get(REANCHOR) === true, version: 0 },
  }));
  on("state.set", { key: "reanchor" }, (_, e) => {
    kept.set(REANCHOR, e.value);
    return { value: { isSet: true as const, version: 0 } };
  });
  const statuses: Array<string | undefined> = [];
  on("ui.status", (_, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  return statuses;
};

/** Records every binary run; `answer` picks the stdout by subcommand. */
export const binary = (
  on: On,
  answer: (subcommand: string) => ReturnType<typeof exited> = () => exited(0),
) => {
  const runs: Run[] = [];
  const written = payloads(on);
  on("process.run", (_, e) => {
    runs.push(asRun(written, e));
    return answer(e.argv[1] ?? "");
  });
  return runs;
};

export const runsOf = (runs: readonly Run[], subcommand: string) =>
  runs.filter((run) => run.argv[1] === subcommand);
