/**
 * Path-scoped project rules on `read` — the OpenCode leg of the prose
 * rules system. Rules with `paths:` frontmatter are left out of the
 * always-on system-prompt block and appended to the read tool's output
 * the first time a matching file is read in a session, which is when
 * Claude Code would load them.
 */

import { toProjectRelative } from "@mimir/plugin-core/project";
import {
  formatScopedRules,
  type ProjectRulesEntry,
  scopedRulesFor,
} from "@mimir/plugin-core/rules";

const READ_TOOL = "read";
const DEFAULT_SESSION = "default";

type ReadInput = {
  readonly tool: string;
  readonly sessionID?: string;
  readonly args: Readonly<Record<string, unknown>>;
};

type ReadOutput = { output: string };

/** sessionID → scoped rule paths already appended in that session. */
export type ScopedRulesSeen = Map<string, Set<string>>;

export const createScopedRulesSeen = (): ScopedRulesSeen => new Map();

/**
 * Append the scoped rules that apply to the file just read. Returns true
 * when something was appended. No-op for other tools, reads without a
 * string filePath, and rules already surfaced in this session.
 */
export const appendScopedRules = (
  input: ReadInput,
  output: ReadOutput,
  projectPath: string,
  entries: readonly ProjectRulesEntry[],
  seen: ScopedRulesSeen,
) => {
  if (input.tool !== READ_TOOL) return false;
  const filePath = input.args.filePath;
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  const relative = toProjectRelative(projectPath, filePath);
  const sessionId = input.sessionID ?? DEFAULT_SESSION;
  const seenHere = seen.get(sessionId) ?? new Set<string>();
  const fresh = scopedRulesFor(entries, relative).filter(
    (e) => !seenHere.has(e.path),
  );
  if (fresh.length === 0) return false;
  const block = formatScopedRules(fresh, relative);
  if (!block) return false;
  for (const e of fresh) seenHere.add(e.path);
  seen.set(sessionId, seenHere);
  output.output = `${output.output}\n\n${block}`;
  return true;
};
