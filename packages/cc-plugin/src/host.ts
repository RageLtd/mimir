/**
 * Which host is driving this Claude Code session, as far as hook output
 * is concerned.
 *
 * Hooks may return a `systemMessage` — a one-line notice meant for the
 * developer, never the model. The terminal TUI renders it as a dim status
 * line and the desktop app collapses it into a "Claude Code notice" row,
 * which is what the "↻ Retrieved N memories" markers were designed for.
 * Agent-SDK hosts don't: Zed's Claude Code agent stamps it as a "Notice:"
 * and glues it to the front of the reply with no line break.
 *
 * Claude Code names the host in CLAUDE_CODE_ENTRYPOINT — "cli" for the
 * terminal, "claude-desktop" for the desktop app, "sdk-ts" / "sdk-py" for
 * SDK-driven hosts. Unset means an older CLI; treat it as the terminal.
 */

const NOTICE_RENDERING_ENTRYPOINTS = new Set(["cli", "claude-desktop"]);

export const hostRendersNotices = (env: NodeJS.ProcessEnv = process.env) => {
  const entrypoint = env.CLAUDE_CODE_ENTRYPOINT;
  return (
    entrypoint === undefined || NOTICE_RENDERING_ENTRYPOINTS.has(entrypoint)
  );
};

/** `{ systemMessage }` for hosts that render it, `{}` for the rest. */
export const noticeFor = (message: string, env?: NodeJS.ProcessEnv) =>
  hostRendersNotices(env) ? { systemMessage: message } : {};
