/**
 * The bridge from the hooks module to the mimir-cc binary.
 *
 * The module runs in the engine's sandbox — no Node, no Bun, no bare
 * imports — so everything that touches sqlite, the embedder or the
 * cartographer stays in `~/.local/bin/mimir-cc`. Each leg is a subcommand
 * that reads a hook payload on stdin and answers with the same JSON the
 * command-hook contract uses.
 *
 * These helpers are pure on purpose: `claude plugin validate` follows `$`
 * only within one file, so a hook spells `$.process.run(argv, init)`
 * itself and this file only shapes the call and reads the answer.
 */

import type { ModelCompleteRequest, ModelCompleteResult } from "claude-code";

export const MIMIR_CC_BINARY = ".local/bin/mimir-cc";

/** The tier extraction and summaries run on: a clean, cheap completion. */
export const EXTRACTION_MODEL = "haiku";
/**
 * `$` time is off the hook's budget, so these bound the completion itself.
 * Persist's sits inside `turn.complete` and extracts from a short delta;
 * a compaction's summary may genuinely take longer.
 */
export const PERSIST_COMPLETION_TIMEOUT_MS = 20_000;
export const PRECOMPACT_COMPLETION_TIMEOUT_MS = 60_000;

/** A completion the binary rendered and wants the session's model to run. */
export type CompletionRequest = {
  readonly system: string;
  readonly prompt: string;
  readonly maxTokens: number;
};

/** What goes back to the binary per request: the reply, or why there is none. */
export type Completion = { readonly text: string } | { readonly error: string };

/** The subset of a command hook's stdout JSON the module acts on. */
export type HookOutput = {
  readonly hookSpecificOutput?: {
    readonly additionalContext?: string;
  };
  readonly systemMessage?: string;
  /** persist / precompact: whether the delta they were handed is settled. */
  readonly advance?: boolean;
  /** persist / precompact phase one: completions to run, then run again. */
  readonly requests?: Readonly<Record<string, CompletionRequest>>;
  /** retrieve: the last session's summary is still being written, so the
   *  next prompt asks for it again. */
  readonly summaryPending?: boolean;
};

/** `argv` for `$.process.run`: the installed binary and one subcommand. */
export const mimirCcArgv = (home: string, subcommand: string) => [
  `${home}/${MIMIR_CC_BINARY}`,
  subcommand,
];

/** `init` for `$.process.run`: the payload (if any) on stdin, gates passed. */
export const mimirCcInit = (payload: unknown, timeoutMs: number) => ({
  env: { MIMIR_ACTIVE: "1" },
  timeoutMs,
  ...(payload === undefined ? {} : { stdin: JSON.stringify(payload) }),
});

export const parseHookOutput = (stdout: string) => {
  if (stdout.trim().length === 0) return {};
  // Serialisation boundary: the binary's stdout is JSON of a known shape.
  return JSON.parse(stdout) as HookOutput;
};

/** `parseHookOutput` as a result: stdout that is not JSON is an error. */
export const readHookOutput = (stdout: string) =>
  Promise.resolve(stdout)
    .then(parseHookOutput)
    .then(
      (output) => ({ output, error: null }),
      (cause: unknown) => ({
        output: null,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    );

/** The `$.model.complete` request for one of the binary's requests. */
export const completionAsk = (request: CompletionRequest, timeoutMs: number) =>
  ({
    model: EXTRACTION_MODEL,
    system: request.system,
    prompt: request.prompt,
    maxTokens: request.maxTokens,
    effort: "low",
    timeoutMs,
  }) satisfies ModelCompleteRequest;

const unansweredReason = (
  result: Extract<ModelCompleteResult, { isAnswered: false }>,
) =>
  result.reason === "api-error"
    ? `api-error ${result.status ?? "no-response"} ${result.error}`
    : result.reason;

export const completionOutcome = (result: ModelCompleteResult) =>
  (result.isAnswered
    ? { text: result.text }
    : { error: unansweredReason(result) }) satisfies Completion;

/** A `$.model.complete` the engine refused to send, as its reason. */
export const completionRefusal = (cause: unknown) =>
  ({
    error: cause instanceof Error ? cause.message : String(cause),
  }) satisfies Completion;
