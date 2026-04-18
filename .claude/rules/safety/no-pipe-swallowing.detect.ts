/**
 * Mechanical detector for the "No Pipe Swallowing" rule.
 * Paired with no-pipe-swallowing.md.
 *
 * Scope: the paired .md frontmatter declares `tools: ["Bash"]` so this
 * detector only runs on Bash tool calls. Scans the `command` string for
 * pipes into known output-filtering commands that silently drop stderr.
 */

import {
  getToolInput,
  type RuleDetectionInput,
  type Violation,
} from "../detection-helpers";

// Matches `| <filter>` where <filter> is one of the known output-trimmers.
// Word boundary around the command name prevents false matches on
// `grep-er` or `headers`.
const SWALLOWING_PIPE = /\|\s*(head|tail|grep|wc|awk|sed)\b/;

/**
 * When the user explicitly redirects stderr (`2>filename` or `2>&1`
 * before the pipe), they're handling the error stream. Simple heuristic:
 * if `2>` appears ANYWHERE before a `|`, consider stderr handled.
 */
const hasExplicitStderrHandling = (command: string) => {
  const pipeIdx = command.indexOf("|");
  if (pipeIdx < 0) return false;
  const preamble = command.slice(0, pipeIdx);
  return /2>[^&]?\S+|2>&1/.test(preamble);
};

export default (input: RuleDetectionInput) => {
  const command = getToolInput(input).command;
  if (typeof command !== "string") return [];

  const match = SWALLOWING_PIPE.exec(command);
  if (!match) return [];
  if (hasExplicitStderrHandling(command)) return [];

  const violations: Violation[] = [
    {
      message: `Command pipes into \`${match[1]}\` — stderr will be swallowed. See the paired rule.`,
      snippet: match[0].trim(),
    },
  ];
  return violations;
};
