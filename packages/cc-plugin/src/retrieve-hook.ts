/**
 * Per-turn retrieval injection — `mimir-cc retrieve`, run by the hooks
 * module's `prompt.submit` hook with the UserPromptSubmit payload.
 *
 * Fires on every developer prompt, the first included (boot context is
 * profile and project only, attached by the same hook beside this one's
 * block on the first prompt and after a reset). On the first,
 * flagged `session_start`, retrieval also brings the active project's
 * newest summary, near the prompt or not. Reads the
 * LOCAL org replica (MIM-84) — no server round-trip — and emits:
 *
 *   - hookSpecificOutput.additionalContext — the `<retrieved_context>`
 *     block, hidden from the developer's transcript view but visible to
 *     the model.
 *   - systemMessage — a tiny "↻ Retrieved N memories / M summaries"
 *     indicator for the developer (NOT seen by the model), which the
 *     hooks module puts on the status line.
 *   - summaryPending — the summary is still owed: the hooks module sends
 *     the next prompt as `session_start` again, until an answer comes back
 *     without the flag. On a first prompt whose project's last summary is
 *     still being written (the summary-pending mark), it is set whatever
 *     the distance gate admitted: the newest-summary fallback stays out of
 *     the slot, while a summary near the prompt is still injected. A first
 *     prompt whose retrieval failed (replica unopenable, retrieval threw)
 *     prints the flag alone, so the summary stays owed without claiming
 *     it is still generating.
 *
 * Empty replica → inject nothing (same contract as an empty retrieval). Run scripts/import-replica.ts to seed it; MIM-86 makes it
 * self-sustaining. The lone remaining network touch is project-id
 * resolution, which is disk-cached after the first call per project.
 *
 * Defence-in-depth: MIMIR_ACTIVE gate matches the rules / reindex hooks
 * so nested `claude` subprocesses can't accidentally fire.
 */

import {
  promptContextOutput,
  retrieveForPrompt,
} from "@mimir/plugin-core/brain/retrieve-prompt";
import { attempt } from "@mimir/plugin-core/result";
import { readPayload } from "./hook-payload";
import { createLogger } from "./logger";

const log = createLogger("retrieve-hook");

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly prompt?: string;
  readonly cwd?: string;
  /** True on the first prompt after a compaction replaced the window. */
  readonly window_reset?: boolean;
  /** True on the session's first prompt: the active project's newest
   *  summary is injected even when it is not near the prompt. */
  readonly session_start?: boolean;
};

const safeParseHookInput = async (raw: string) => {
  if (raw.trim().length === 0) return {} as HookInput;
  const [err, parsed] = await attempt(async () => JSON.parse(raw) as HookInput);
  return err ? ({} as HookInput) : parsed;
};

/**
 * What the hook prints when retrieval itself failed, or null to print
 * nothing. Pure. A first prompt keeps the summary owed — printing nothing
 * would read as settled — with no status line, since no one looked whether
 * it is still being written.
 */
export const retrieveFailureOutput = (input: HookInput) =>
  input.session_start === true ? { summaryPending: true } : null;

const printFailure = (input: HookInput) => {
  const output = retrieveFailureOutput(input);
  if (output !== null) process.stdout.write(JSON.stringify(output));
};

/**
 * Entry point invoked from cli.ts when argv[2] === "retrieve".
 * Returns 0 unconditionally — emitting an error code from
 * UserPromptSubmit would surface as a hook failure to the developer
 * even though the user's prompt would still go through; a failure is
 * logged, and on a first prompt answered with `retrieveFailureOutput`.
 */
export const runRetrieveHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const raw = await readPayload();
  const input = await safeParseHookInput(raw);
  const prompt = input.prompt?.trim() ?? "";

  if (prompt.length === 0) {
    log.debug("empty prompt, skipping");
    return 0;
  }

  // Without a session id there is no window to track: nothing is skipped
  // and nothing recorded.
  const outcome = await retrieveForPrompt({
    sessionId: input.session_id,
    cwd: input.cwd ?? process.cwd(),
    prompt,
    windowReset: input.window_reset === true,
    sessionStart: input.session_start === true,
    log,
  });
  if (outcome.status !== "retrieved") {
    printFailure(input);
    return 0;
  }

  const output = promptContextOutput(outcome.result, outcome);
  if (output !== null) process.stdout.write(JSON.stringify(output));
  return 0;
};
