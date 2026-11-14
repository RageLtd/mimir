/**
 * Boot context on `prompt.context` — the blocks the conversation's first
 * user message carries, re-rendered by the engine after a compaction or
 * `/clear`, so the developer's profile survives both.
 *
 * Runs `mimir-cc boot-context` with the session's cwd and appends its
 * `<boot_context>` block (user profile + active project) to the engine's
 * own blocks. Prior-session context is not here: this fires before any
 * prompt exists to query with, so retrieval runs per turn instead
 * (retrieve.ts), the first turn included.
 *
 * Fails open: a binary that errors costs the session its boot block,
 * never the first message.
 */

import type { Register } from "claude-code";
import { mimirCcArgv, mimirCcInit } from "./binary";

const BOOT_TIMEOUT_MS = 15_000;
export const BOOT_BLOCK_NAME = "mimirBoot";

export const registerBoot: Register = (on) => {
  on("prompt.context", async ($, e, next) => {
    const home = (await $.env.get("HOME")) ?? "";
    const ran = await $.process.run(
      mimirCcArgv(home, "boot-context"),
      mimirCcInit(
        { cwd: await $.session.cwd(), session_id: await $.session.id() },
        BOOT_TIMEOUT_MS,
      ),
    );

    if (ran.exitCode !== 0) {
      $.ui.status(`mimir: boot context failed (exit ${ran.exitCode})`);
      return next(e);
    }
    const text = ran.stdout.trim();
    return text.length === 0
      ? next(e)
      : next({ ...e, blocks: [...e.blocks, { name: BOOT_BLOCK_NAME, text }] });
  }).catch(($, e, next) => {
    $.ui.status("mimir: boot context failed");
    return next(e);
  });
};
