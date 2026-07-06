/**
 * PreCompact hook — belt-and-suspenders persistence before CC discards.
 *
 * Fires when CC is about to compact (either via /compact or auto-trigger).
 * Ships any transcript delta the Stop hook hasn't yet picked up so the
 * brain has the full record before CC's local history gets summarized
 * away.
 *
 * Same primitives as persist-hook: readWatermark, readDelta, shipDelta,
 * writeWatermark. The server-side appendTurn dedup makes overlap with
 * Stop cheap (matching tails are skipped).
 *
 * Never blocks compaction. CC's local compaction is its own concern;
 * we just make sure the brain doesn't lose anything when CC summarizes.
 */

import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import { readConfig } from "./config";
import { createLogger } from "./logger";
import {
  readDelta,
  readWatermark,
  shipDelta,
  writeWatermark,
} from "./transcript-delta";

const log = createLogger("precompact-hook");

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly transcript_path?: string;
  readonly cwd?: string;
  readonly trigger?: "manual" | "auto";
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

/**
 * Entry point invoked from cli.ts when argv[2] === "precompact".
 *
 * Exit 0 unconditionally. Returning non-zero (or emitting
 * `decision: "block"`) would prevent CC from compacting — that's the
 * developer's choice via /compact, not ours to override.
 */
export const runPreCompactHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const raw = await readStdin();
  const input = await safeParseHookInput(raw);

  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  const cwd = input.cwd ?? process.cwd();
  const trigger = input.trigger ?? "unknown";

  if (!sessionId || !transcriptPath) {
    log.debug("missing session_id or transcript_path — skipping", { trigger });
    return 0;
  }

  const config = await readConfig();
  if (!config) {
    log.debug("no config — skipping precompact persist");
    return 0;
  }

  const watermark = await readWatermark(sessionId);
  const { messages, newOffset } = await readDelta(transcriptPath, watermark);

  if (messages.length === 0) {
    if (newOffset > watermark) await writeWatermark(sessionId, newOffset);
    log.info("precompact: nothing new to persist (Stop hook caught up)", {
      sessionId,
      trigger,
      watermark,
      newOffset,
    });
    return 0;
  }

  const projectId = await getOrResolveProjectId(
    config.serverUrl,
    cwd,
    config.apiKey,
  ).catch(() => null);

  const result = await shipDelta(config.serverUrl, messages, cwd, projectId);

  if (!result.ok) {
    log.error(
      "precompact: shipDelta failed — leaving watermark for next attempt",
      {
        sessionId,
        trigger,
        messages: messages.length,
        error: result.error,
      },
    );
    return 0;
  }

  await writeWatermark(sessionId, newOffset);

  log.info("precompact: pre-discard delta persisted", {
    sessionId,
    trigger,
    project: cwd,
    projectId,
    watermark,
    newOffset,
    messagesShipped: messages.length,
    appended: result.appended,
  });

  return 0;
};
