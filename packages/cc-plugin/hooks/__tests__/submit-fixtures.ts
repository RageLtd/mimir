/**
 * Shared fixtures for the `prompt.submit` tests: a session whose whole
 * `$.state` is held in memory (whatever keys the hook keeps), whose
 * conversation the test grows between prompts, and whose binary answers
 * by subcommand.
 */

import type { On } from "claude-code";
import { mock } from "claude-code/testing";
import type { Block, Message } from "../messages";
import {
  CWD,
  exited,
  type Run,
  runsOf,
  SESSION,
} from "../support.test-helpers";
import { parsed } from "./lifecycle-fixtures";

export { BIN, CWD, exited, runsOf, SESSION } from "../support.test-helpers";
export { parsed } from "./lifecycle-fixtures";

export const HOME = "/home/t";
export const CONTEXT = "<retrieved_context>one memory</retrieved_context>";
export const ANCHOR = "<voice_anchor>\nMimir: Aye.\n</voice_anchor>";
export const BOOT =
  "<boot_context>\n<user_profile_section>Rage</user_profile_section>\n</boot_context>";
export const RETRIEVED_STATUS = "↻ Retrieved 1 memory";
export const BOOT_FAILED = /^mimir: boot context failed/;

export const submitted = (text: string, context?: readonly string[]) => ({
  text,
  wait: false,
  origin: { kind: "composer" } as const,
  ...(context ? { context } : {}),
});

/** A slash command's submission: it runs `/name`, the conversation unchanged. */
export const slashCommand = (name: string) => ({
  ...submitted(`/${name}`),
  command: { name, args: "" },
});

/** A prompt typed while turn `turnId` runs: it does not grow the window. */
export const midTurn = (text: string, turnId: string) => ({
  ...submitted(text),
  turnId,
});

/**
 * `session.end` as the engine raises it for `sessionId`: `clear` for a
 * `/clear`, `resume` for an in-process resume. Either way the process goes
 * on under another session id, which a test sets with `switchTo`.
 */
export const ending = (reason: "clear" | "resume", sessionId: string) => ({
  reason,
  sessionId,
  resume: { id: sessionId },
});

export const retrieved = (context: string, message: string) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
    systemMessage: message,
  });

/** Every `window_reset` retrieval was told, in order. */
export const windowResets = (runs: readonly Run[]) =>
  runsOf(runs, "retrieve").map((run) => parsed(run.stdin).window_reset);

/** The `nth` of every voice-anchor run, in order. */
export const anchorNths = (runs: readonly Run[]) =>
  runsOf(runs, "voice-anchor").map((run) => run.argv.at(-1));

/**
 * The plugin's `$.state`, every key, held in memory the way the host holds
 * it: a value never written is undefined at version 0.
 */
const pluginState = (on: On) => {
  const cells = new Map<string, { value: unknown; version: number }>();
  const address = (e: { key: string; id?: string }) =>
    e.id === undefined ? e.key : `${e.key}/${e.id}`;
  on("state.get", { plugin: "mimir-cc" }, (_, e) => ({
    value: cells.get(address(e)) ?? { value: undefined, version: 0 },
  }));
  on("state.set", { plugin: "mimir-cc" }, (_, e) => {
    const at = cells.get(address(e))?.version ?? 0;
    if (e.ifVersion !== undefined && e.ifVersion !== at) {
      return { value: { isSet: false as const, version: at } };
    }
    cells.set(address(e), { value: e.value, version: at + 1 });
    return { value: { isSet: true as const, version: at + 1 } };
  });
  return {
    get: (key: string) => cells.get(key)?.value,
    /** A write from elsewhere, as lifecycle.ts makes one on a compaction. */
    put: (key: string, value: unknown) => {
      const at = cells.get(key)?.version ?? 0;
      cells.set(key, { value, version: at + 1 });
    },
  };
};

const textOf = (block: Block) =>
  block.type === "text" && typeof block.text === "string" ? [block.text] : [];

const user = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text", text }],
});
const assistant = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text", text }],
});

/** One exchange of the conversation, distinct from every other `n`'s. */
export const exchange = (n: number) => [
  user(`question ${n}`),
  assistant(`answer ${n}`),
];

/** What a compaction leaves in place of the conversation. */
export const compacted = [
  user("This session is being continued from a previous conversation."),
  assistant("Understood; carrying on."),
];

type Answer = (subcommand: string) => ReturnType<typeof exited>;

/** The version the plugin's manifest carries unless a test says otherwise. */
export const PLUGIN_VERSION = "1.11.0";

export const manifest = (version: unknown) =>
  JSON.stringify({ name: "mimir-cc", version });

/**
 * The session a submit test runs in. `answer` picks a run's result by
 * subcommand and may be swapped between prompts; `say` sets the
 * conversation the next prompt sees. Work deferred through the clock runs
 * only when the test advances `clock`; `version` is what the plugin's
 * manifest carries, and `manifests` the paths read from it. `switchTo`
 * sets the session id and cwd the next prompts see, as the process going
 * on after a `/clear` or a resume does; until then they are `SESSION` and
 * `CWD`. `unreadable` makes reading the session's messages throw. A
 * `session.end` the test raises (`ending`) passes on.
 *
 * It installs a mocked clock and an `fs.read` handler for the plugin
 * manifest, so a test that registers its own clock or `fs.read` handler
 * must not also expect these.
 */
export const submitSession = (
  on: On,
  env: Record<string, string> = {},
  initial: Answer = () => exited(0),
  version: unknown = PLUGIN_VERSION,
) => {
  const state = pluginState(on);
  let messages: readonly Message[] = [];
  let failing = false;
  // Each form as the engine answers it: `{ as: "api" }` the blocks, no `as`
  // the rows, their text blocks joined.
  on("session.messages", (_, e) => {
    if (failing) throw new Error("session.messages: transcript unreadable");
    return {
      value:
        e.as === "api"
          ? messages.map((m) => ({ role: m.role, content: [...m.content] }))
          : messages.map((m) => ({
              role: m.role,
              text: m.content.flatMap(textOf).join("\n"),
              toolUses: [],
            })),
    };
  });
  const say = (next: readonly Message[]) => {
    messages = next;
  };
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  const clock = mock.clock(on);
  const manifests: string[] = [];
  on("fs.read", (_, e) => {
    manifests.push(e.path);
    return { value: manifest(version) };
  });
  mock.env(on, { HOME, ...env });
  let current = { id: SESSION, cwd: CWD };
  on("session.id", () => ({ value: current.id }));
  on("session.cwd", () => ({ value: current.cwd }));
  on("prompt.submit", (_, e) => ({ text: e.text, context: e.context }));
  const statuses: Array<string | undefined> = [];
  on("ui.status", (_, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  let answer = initial;
  const runs: Run[] = [];
  on("process.run", (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, env: e.init?.env });
    return answer(e.argv[1] ?? "");
  });
  return {
    state,
    say,
    clock,
    manifests,
    statuses,
    runs,
    answer: (next: Answer) => {
      answer = next;
    },
    switchTo: (id: string, cwd: string) => {
      current = { id, cwd };
    },
    unreadable: (isUnreadable: boolean) => {
      failing = isUnreadable;
    },
  };
};

/**
 * Prompts 1..n of an ordinary session, each seeing the conversation so far:
 * exchange k-1 has been answered by the time prompt k is submitted.
 */
export const converse = async (
  submit: (text: string) => Promise<unknown>,
  say: (messages: readonly Message[]) => void,
  from: number,
  to: number,
  before: readonly Message[] = [],
) => {
  let seen = [...before];
  for (let n = from; n <= to; n++) {
    say(seen);
    await submit(`question ${n}`);
    seen = [...seen, ...exchange(n)];
  }
  return seen;
};
