/**
 * System Prompt Endpoint
 *
 * GET /v1/system-prompt
 *
 * Returns the current system prompt markdown with a version hash.
 * The version is a content hash so clients can skip re-fetching
 * if nothing changed (ETag-style).
 *
 * Used by mimir-acp's context-client to fetch and cache the system
 * prompt for the CC backend, with configurable TTL.
 */

import { Hono } from "hono";
import { config } from "../config";
import { requestLog } from "../util/logger";

export const systemPrompt = new Hono();

let cachedContent: string | null = null;
let versionHash: string | null = null;
let lastMtime = 0;

/**
 * Load the system prompt from disk with in-memory caching.
 * Re-reads when the file changes (hot-reload via mtime check).
 */
export async function loadPrompt(): Promise<{
  content: string;
  version: string;
}> {
  const file = Bun.file(config.systemPromptPath);
  const stat = await file.stat();

  if (cachedContent && stat.mtimeMs === lastMtime) {
    return { content: cachedContent, version: versionHash ?? "" };
  }

  const raw = await file.text();
  // Content hash for version — stable across restarts,
  // changes only when the file content changes
  versionHash = Bun.hash(raw).toString(16).slice(0, 12);
  cachedContent = raw;
  lastMtime = stat.mtimeMs;

  return { content: cachedContent, version: versionHash };
}

/**
 * GET /v1/system-prompt
 *
 * Returns the current system prompt with content version.
 */
systemPrompt.get("/", async (c) => {
  const rid = c.req.header("x-request-id") ?? "sysprompt";
  const log = requestLog(rid);

  try {
    const { content, version } = await loadPrompt();
    log.debug({ length: content.length, version }, "system prompt served");
    return c.json({ content, version });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, "failed to load system prompt");
    return c.json({ error: "Failed to load system prompt" }, 500);
  }
});
