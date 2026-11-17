/**
 * Per-turn retrieval injection — UserPromptSubmit hook (ported from
 * cc-plugin).
 *
 * Fires on every developer prompt EXCEPT the first one (boot-context
 * handles the first prompt, owned by voice-anchor.ts). Reads the LOCAL
 * org replica — no server round-trip — and emits:
 *
 *   - hookSpecificOutput.additionalContext — the `<retrieved_context>`
 *     block, hidden from the developer's transcript view but visible to
 *     the model (Codex's hook output schema matches CC's — verified in
 *     codex-rs/hooks/schema).
 *   - systemMessage — a tiny "↻ Retrieved N memories / M summaries"
 *     indicator displayed to the developer (NOT seen by the model).
 *
 * Empty or missing replica → inject nothing (same contract as an empty
 * retrieval).
 *
 * State: `~/.mimir/retrieve-state/<session-id>.json` — created on the
 * first hook call as a marker. Subsequent calls in the same session see
 * the marker exists and proceed with retrieval.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  promptContextOutput,
  retrieveForPrompt,
} from "@mimir/plugin-core/brain/retrieve-prompt";
import { mimirHome } from "@mimir/plugin-core/util";
import { readHookInput } from "./hook-input";
import { createLogger } from "./logger";

const log = createLogger("retrieve-hook");

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly prompt?: string;
  readonly cwd?: string;
};

const markerPath = (sessionId: string) =>
  join(mimirHome(), "retrieve-state", `${sessionId}.json`);

const ensureMarker = async (sessionId: string) => {
  const path = markerPath(sessionId);
  const file = Bun.file(path);
  if (await file.exists()) return true;
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  await Bun.write(path, JSON.stringify({ initialized: Date.now() }));
  return false;
};

/**
 * Entry point invoked from cli.ts when argv[2] === "retrieve".
 * Returns 0 unconditionally — a hook failure would surface to the
 * developer even though their prompt still goes through; failing
 * silently in the log file is the right trade-off.
 */
export const runRetrieveHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const input = await readHookInput<HookInput>();
  const sessionId = input.session_id ?? "default";
  const prompt = input.prompt?.trim() ?? "";
  const cwd = input.cwd ?? process.cwd();

  if (prompt.length === 0) {
    log.debug("empty prompt, skipping");
    return 0;
  }

  const seenBefore = await ensureMarker(sessionId);
  if (!seenBefore) {
    log.debug("first prompt of session — boot-context owns this turn");
    return 0;
  }

  // No window reset and no session start: compaction and the first prompt
  // are not tracked here, so no summary is ever owed. Without a session id
  // there is no window to track: nothing is skipped and nothing recorded.
  const outcome = await retrieveForPrompt({
    sessionId: input.session_id,
    cwd,
    prompt,
    log,
  });
  if (outcome.status !== "retrieved") return 0;

  const output = promptContextOutput(outcome.result, outcome);
  if (output !== null) process.stdout.write(JSON.stringify(output));
  return 0;
};
