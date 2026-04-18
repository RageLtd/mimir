/**
 * Mechanical detector for the "No Pipe Swallowing" rule.
 * Paired with no-pipe-swallowing.md. Scans `Bash` tool invocations for
 * pipes into known output-filtering commands (`head`, `tail`, `grep`,
 * `wc`, `awk`, `sed`) that silently drop stderr or truncate diagnostic
 * output.
 *
 * Fires ONLY on `Bash` tool calls — file edits are not scanned by this
 * detector. The advisory message points at the paired rule which shows
 * the "capture to file, then filter" pattern.
 *
 * Safe exits:
 *   - Commands that redirect stderr explicitly (`2>/tmp/err.log`) before
 *     piping are not flagged because the user is consciously handling the
 *     error stream. Detected by looking for `2>` prior to the pipe.
 *   - Here-docs and heredoc bodies are not distinguished from the outer
 *     command — this is a regex detector, not a shell parser. Rare FP.
 */

interface DetectInput {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly filePath?: string;
  readonly content?: string;
}

// Matches `| <filter>` where <filter> is one of the known output-trimmers.
// Word boundary around the command name prevents false matches on `grep-er`
// or `headers`. The pipe can have optional whitespace.
const SWALLOWING_PIPE = /\|\s*(head|tail|grep|wc|awk|sed)\b/;

// When the user explicitly redirects stderr (`2>filename` or `2>&1` before
// the pipe), they're handling the error stream. Simple heuristic: if `2>`
// appears ANYWHERE before a `|`, consider stderr handled. Not perfect but
// low-false-negative for the intent.
const hasExplicitStderrHandling = (command: string) => {
  const pipeIdx = command.indexOf("|");
  if (pipeIdx < 0) return false;
  const preamble = command.slice(0, pipeIdx);
  return /2>[^&]?\S+|2>&1/.test(preamble);
};

const detect = (input: DetectInput) => {
  if (input.toolName !== "Bash") return [];
  const command = input.toolInput.command;
  if (typeof command !== "string") return [];

  // Only flag the piped-to-swallower pattern, and only when stderr isn't
  // explicitly redirected elsewhere first.
  const match = SWALLOWING_PIPE.exec(command);
  if (!match) return [];
  if (hasExplicitStderrHandling(command)) return [];

  return [
    {
      message: `Command pipes into \`${match[1]}\` — stderr will be swallowed. See the paired rule.`,
      snippet: match[0].trim(),
    },
  ];
};

export default detect;
