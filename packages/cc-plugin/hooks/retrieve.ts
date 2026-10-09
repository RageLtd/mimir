/**
 * Per-turn brain retrieval on `prompt.submit`.
 *
 * Runs `mimir-cc retrieve` with the UserPromptSubmit payload and attaches
 * its `additionalContext` as prompt context — what the model reads beside
 * the prompt and the developer never sees. The binary's `systemMessage`
 * (the "↻ Retrieved N memories" line) goes to the status line instead of
 * the transcript.
 *
 * Fails open: a binary that errors or times out costs the turn its
 * retrieval, never the prompt.
 */

import type { Register } from "claude-code";
import { mimirCcArgv, mimirCcInit, parseHookOutput } from "./binary";

const RETRIEVE_TIMEOUT_MS = 15_000;

export const registerRetrieve: Register = (on) => {
  on("prompt.submit", async ($, e, next) => {
    const home = (await $.env.get("HOME")) ?? "";
    const payload = {
      session_id: await $.session.id(),
      hook_event_name: "UserPromptSubmit",
      prompt: e.text,
      cwd: await $.session.cwd(),
    };
    const ran = await $.process.run(
      mimirCcArgv(home, "retrieve"),
      mimirCcInit(payload, RETRIEVE_TIMEOUT_MS),
    );

    if (ran.exitCode !== 0) {
      $.ui.status(`mimir: retrieve failed (exit ${ran.exitCode})`);
      return next(e);
    }
    const out = parseHookOutput(ran.stdout);
    if (out.systemMessage !== undefined) $.ui.status(out.systemMessage);
    const extra = out.hookSpecificOutput?.additionalContext;
    return extra === undefined
      ? next(e)
      : next({ ...e, context: [...(e.context ?? []), extra] });
  }).catch(($, e, next) => {
    $.ui.status("mimir: retrieve failed");
    return next(e);
  });
};
