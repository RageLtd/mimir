/**
 * Stop hook — persist completed CC turns to the mimir brain.
 *
 * Fires after every model turn ends (CC's Stop event). Reads new lines
 * from the session's transcript JSONL since the last watermark, converts
 * them to AI SDK ModelMessages via `transcript-delta.ts`, ships to
 * `/v1/messages/persist`, and advances the watermark.
 *
 * Also reports a rough token count to `/v1/context/token-report` so the
 * brain's async compaction threshold actually fires for CC-driven
 * growth. Without this, the server only sees ACP-side traffic and
 * compaction never triggers from pure-CC usage.
 *
 * Exit code is always 0. Returning non-zero from Stop would prevent CC
 * from finishing the turn — far worse than a silent persist failure
 * (which we recover from on the next turn via the unchanged watermark).
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";

import { authHeaders, readConfig } from "./config";
import { createLogger } from "./logger";
import { getOrResolveProjectId } from "./project";
import { attempt } from "./result";
import {
  readDelta,
  readWatermark,
  shipDelta,
  writeWatermark,
} from "./transcript-delta";

const log = createLogger("persist-hook");

const TOKEN_REPORT_ROUTE = "/v1/context/token-report";

// Rough char-to-token heuristic. Anthropic's tokenizer averages ~3.5–4
// chars per token for English/code. Slight overcount is intentional —
// the compaction trigger is conservative by design.
const CHARS_PER_TOKEN = 4;

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly transcript_path?: string;
  readonly cwd?: string;
};

const readStdin = async () => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const safeParseHookInput = async (raw: string) => {
  if (raw.trim().length === 0) return {} as HookInput;
  const [err, parsed] = await attempt(async () => JSON.parse(raw) as HookInput);
  return err ? ({} as HookInput) : parsed;
};

const stringifyContent = (content: ModelMessage["content"]) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (!p || typeof p !== "object") return "";
      // Cheap textual approximation — text parts contribute their text,
      // tool calls / results contribute their JSON shape so the token
      // estimate accounts for them.
      const part = p as {
        type?: string;
        text?: string;
        input?: unknown;
        output?: unknown;
      };
      if (part.type === "text") return part.text ?? "";
      return JSON.stringify(part);
    })
    .join("\n");
};

const estimatePromptTokens = (messages: readonly ModelMessage[]) => {
  let chars = 0;
  for (const m of messages) chars += stringifyContent(m.content).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
};

const reportTokens = async (
  serverUrl: string,
  promptTokens: number,
  project: string,
  projectId: string | null,
) => {
  if (promptTokens <= 0) return;
  const url = `${serverUrl}${TOKEN_REPORT_ROUTE}`;
  const auth = await authHeaders();
  const [err, response] = await attempt(() =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        promptTokens,
        project,
        ...(projectId ? { projectId } : {}),
      }),
    }),
  );
  if (err) {
    log.warn("token-report fetch failed", { url, error: err.message });
    return;
  }
  if (!response.ok) {
    log.warn("token-report non-OK", { url, status: response.status });
  }
};

/**
 * Entry point invoked from cli.ts when argv[2] === "persist".
 *
 * Exit 0 on every path. Returning non-zero from Stop prevents CC from
 * finishing the turn, which would be a much worse failure mode than
 * losing one persist cycle.
 */
export const runPersistHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const raw = await readStdin();
  const input = await safeParseHookInput(raw);

  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  const cwd = input.cwd ?? process.cwd();

  if (!sessionId) {
    log.debug("no session_id in hook payload — skipping");
    return 0;
  }
  if (!transcriptPath) {
    log.debug("no transcript_path in hook payload — skipping");
    return 0;
  }

  const config = await readConfig();
  if (!config) {
    log.debug("no config — skipping persist");
    return 0;
  }

  const watermark = await readWatermark(sessionId);
  const { messages, newOffset } = await readDelta(transcriptPath, watermark);

  if (messages.length === 0) {
    // Still advance the watermark if we read past empty/meta lines, so we
    // don't re-scan them next turn.
    if (newOffset > watermark) await writeWatermark(sessionId, newOffset);
    log.debug("no new messages in delta", {
      sessionId,
      watermark,
      newOffset,
    });
    return 0;
  }

  const projectId = await getOrResolveProjectId(config.serverUrl, cwd).catch(
    () => null,
  );

  const result = await shipDelta(config.serverUrl, messages, cwd, projectId);

  if (!result.ok) {
    log.error("shipDelta failed — leaving watermark in place for retry", {
      sessionId,
      messages: messages.length,
      error: result.error,
    });
    return 0;
  }

  await writeWatermark(sessionId, newOffset);

  // Token-report runs after a successful ship so the server's tracker
  // stays consistent with what's actually been logged. Fire-and-forget;
  // a failed report just means the next turn carries more weight.
  const promptTokens = estimatePromptTokens(messages);
  await reportTokens(config.serverUrl, promptTokens, cwd, projectId);

  log.info("turn persisted", {
    sessionId,
    project: cwd,
    projectId,
    watermark,
    newOffset,
    messagesShipped: messages.length,
    appended: result.appended,
    estimatedTokens: promptTokens,
  });

  return 0;
};
