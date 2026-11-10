/**
 * Claude Code version gate for the install.
 *
 * The plugin's hooks are a hooks module (hooks/register.ts) — a Claude Code
 * older than MIN_CLAUDE_CODE_VERSION ignores `modules` in hooks.json and
 * runs a session with no Mimir hooks at all, silently. The installer
 * refuses that rather than leaving the developer to notice the brain is
 * dark. A machine with no `claude` on PATH is only warned: the plugin can
 * be installed ahead of Claude Code.
 *
 * The minimum is the oldest Claude Code the module has been run on, not
 * the first that loads a hooks module: the changelog never announces most
 * of the `$` calls the module makes, so an older version cannot be shown
 * to have them. Lower it only with a `claude plugin validate` and
 * `claude plugin test` pass on that version.
 */

import { attempt } from "@mimir/plugin-core/result";

export const MIN_CLAUDE_CODE_VERSION = "2.1.319";

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/;

export const parseVersion = (text: string) => {
  const match = VERSION_PATTERN.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
};

export const isAtLeast = (version: string, minimum: string) => {
  const have = parseVersion(version);
  const need = parseVersion(minimum);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
};

/** `claude --version` stdout, or null when the binary cannot be run. */
export type ReadVersion = () => Promise<string | null>;

export const readInstalledClaudeVersion: ReadVersion = async () => {
  const [spawnErr, proc] = await attempt(async () =>
    Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "ignore" }),
  );
  if (spawnErr) return null;
  const text = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return exitCode === 0 ? text : null;
};

export type ClaudeVersionCheck =
  | { readonly kind: "ok"; readonly version: string }
  | { readonly kind: "missing" }
  | { readonly kind: "too-old"; readonly version: string };

export const checkClaudeVersion = async (
  read: ReadVersion = readInstalledClaudeVersion,
  minimum = MIN_CLAUDE_CODE_VERSION,
) => {
  const text = await read();
  const version = text === null ? null : parseVersion(text);
  if (version === null) return { kind: "missing" } as const;
  const found = version.join(".");
  return isAtLeast(found, minimum)
    ? ({ kind: "ok", version: found } as const)
    : ({ kind: "too-old", version: found } as const);
};
