/**
 * Middleware 1: System Prompt Injection
 *
 * Loads the stable system prompt from disk and injects it into the context.
 * The prompt is cached in memory with hot-reload on file change.
 *
 * Pure function on ctx — no return value, no format conversion.
 */

import { config } from "../config";
import { log } from "../util/logger";
import type { MimirContext } from "./types";

let cachedPrompt: string | null = null;
let lastModified: number = 0;

/**
 * Load the system prompt from disk with caching.
 */
async function loadSystemPrompt(): Promise<string> {
  const file = Bun.file(config.systemPromptPath);
  const stat = await file.stat();

  if (!cachedPrompt || stat.mtimeMs !== lastModified) {
    cachedPrompt = await file.text();
    lastModified = stat.mtimeMs;
    log.debug({ path: config.systemPromptPath }, "loaded system prompt");
  }

  return cachedPrompt;
}

/**
 * Inject the system prompt into the context.
 *
 * The system prompt contains ONLY stable behavioral instructions — identity,
 * response format, critical rules, tool usage, professional conduct, voice.
 *
 * Dynamic session context (date/time, project path, rules, memories, index
 * status, background tasks) is injected by assembleContext() as a synthetic
 * user+assistant message pair at the start of the conversation.
 */
export async function injectSystemPrompt(ctx: MimirContext): Promise<void> {
  const raw = await loadSystemPrompt();

  // Inject current date
  const today = new Date().toISOString().split("T")[0] as string;
  ctx.systemPrompt = raw.replace("{{DATE}}", today);

  log.debug(
    {
      promptLength: ctx.systemPrompt.length,
      project: ctx.project,
    },
    "system prompt injected",
  );
}
