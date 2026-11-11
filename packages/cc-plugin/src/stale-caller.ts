/**
 * Calls made the way a plugin older than this binary makes them. The
 * binary updates on every wrapper launch; the plugin only when the
 * developer updates it, so for a while the old `hooks.json` drives the new
 * binary. Its calls are answered cleanly instead of failing a hook on
 * every prompt and Bash call.
 */

/** Shown once per prompt, through the one stale call that fires there. */
export const STALE_PLUGIN_NOTICE =
  "Mimir: the installed mimir-cc plugin is older than its binary — update the mimir-cc plugin. Until then turns are not distilled into memory and the shell-edit guard is off.";

/**
 * The stale call `command` is, or null when it is current: `edit-guard`
 * moved into the hooks module, and `voice-anchor` now takes its session
 * and turn as arguments instead of a hook payload on stdin.
 */
export const staleCaller = (
  command: string | undefined,
  rest: readonly string[],
) => {
  if (command === "edit-guard") return { command, isShown: false };
  if (command === "voice-anchor" && rest.length === 0)
    return { command, isShown: true };
  return null;
};
