/**
 * Edit guard — the `tool.call` hook on Bash.
 *
 * Claude Code's auto permission mode tells the model to prefer Bash
 * (sed, heredocs, short scripts) over the Read/Edit/Write tools. That
 * costs the developer the one thing they watch the chat for: edits shown
 * as diffs. This hook gives auto mode back its edit tools without giving
 * up the rest of it: a command that rewrites files through the shell is
 * denied with a reason pointing at the Edit tool (shell-edit.ts decides).
 *
 * A `tool.call` deny is honoured in every permission mode. No binary
 * runs: the whole decision is in-process. Disable per session with
 * MIMIR_EDIT_GUARD=0.
 */

import type { Register } from "claude-code";
import { decide } from "./shell-edit";

export const registerEditGuard: Register = (on) => {
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    if ((await $.env.get("MIMIR_EDIT_GUARD")) === "0") return next(e);
    const deny = decide(e.command);
    return deny === null ? next(e) : { deny };
  }).catch(($, e, next) => {
    $.ui.status("mimir: edit guard failed");
    return next(e);
  });
};
