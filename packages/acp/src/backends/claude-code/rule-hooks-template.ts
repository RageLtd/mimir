/**
 * Canonical content of `.claude/rules/detection-helpers.ts`. Written at
 * session start when any detectors are present so sidecar authors can
 * `import { ... } from "../detection-helpers"` without needing to know
 * what shape this version of mimir speaks.
 *
 * Changes here ripple to every project that uses mimir, so additions
 * should be additive — never break the existing API.
 *
 * Lives in its own file (rather than embedded inline in rule-hooks.ts)
 * because it's effectively a static asset: TypeScript source meant for
 * the user's project, written out verbatim. Keeping it separate makes
 * the rule-hooks loader easier to read and the template easier to edit
 * with proper syntax highlighting.
 */
export const HELPERS_FILE_CONTENT = `/**
 * Rule-detect sidecar types and helpers.
 *
 * This file is managed by mimir-acp — it's (re)written at session start
 * to mirror whatever version of mimir is running. Feel free to commit it
 * or .gitignore it as you prefer; mimir will keep it in sync either way.
 *
 * User-authored helpers should go in a separate file — mimir overwrites
 * this one whenever its canonical content changes.
 *
 * Sidecars (\`.claude/rules/**\\/*.detect.ts\`) can import from this file:
 *
 *   import {
 *     getIncomingContent,
 *     getToolInput,
 *     scanLines,
 *     type RuleDetectionInput,
 *     type Violation,
 *   } from "../detection-helpers";
 *
 *   const RETURN_TYPE = /\\)\\s*:\\s*[A-Za-z]+\\s*(=>|\\{)/;
 *
 *   export default (input: RuleDetectionInput) => {
 *     const content = getIncomingContent(getToolInput(input));
 *     if (!content) return [];
 *     return scanLines(content, RETURN_TYPE, "explicit return type");
 *   };
 *
 * Importing is optional — detectors can build their own extraction
 * logic. These exist purely to spare you the boilerplate.
 */

// ── Types ──

/** A single rule violation found by a detector. */
export interface Violation {
  /** Short human-readable description of what's wrong. */
  readonly message: string;
  /** Optional 1-indexed line number where the violation occurs. */
  readonly line?: number;
  /** Optional code snippet highlighting the offending text. */
  readonly snippet?: string;
}

/**
 * Input handed to every detect function.
 *
 * File-path and tool-name scoping is declared in the paired \`.md\`
 * frontmatter (\`globs\` and \`tools\`) and enforced by mimir BEFORE the
 * detector is invoked — so if your function runs, the scope matched.
 */
export interface RuleDetectionInput {
  /**
   * Raw hook event from the Claude Agent SDK. For PreToolUse this
   * carries \`hook_event_name\`, \`tool_name\`, and \`tool_input\`. Nothing
   * is pre-parsed — inspect it however you need.
   */
  readonly hookEvent: Record<string, unknown>;
  /**
   * Path to the file this tool is operating on, extracted from the
   * tool input when a file is involved. Undefined for tools like
   * \`Bash\` that don't target a specific file.
   */
  readonly filePath?: string;
}

// ── Helpers ──

/** Narrow \`input.hookEvent.tool_input\` to a Record<string, unknown>. */
export const getToolInput = (input: RuleDetectionInput) =>
  (input.hookEvent.tool_input ?? {}) as Record<string, unknown>;

/**
 * Pull the incoming file content from an Edit / Write / MultiEdit tool
 * input. Returns:
 *   - \`toolInput.new_string\` for Edit
 *   - \`toolInput.content\` for Write
 *   - concatenated \`new_string\` values for MultiEdit
 *   - \`null\` when the tool doesn't carry inbound content (e.g. Bash)
 *
 * Intended for detectors that scan "what's about to land in the file"
 * without caring which edit tool produced it. Detectors that need
 * post-edit file state should read from disk with \`Bun.file\` directly.
 */
export const getIncomingContent = (toolInput: Record<string, unknown>) => {
  if (typeof toolInput.new_string === "string") return toolInput.new_string;
  if (typeof toolInput.content === "string") return toolInput.content;
  if (Array.isArray(toolInput.edits)) {
    const parts: string[] = [];
    for (const e of toolInput.edits) {
      if (
        e &&
        typeof e === "object" &&
        typeof (e as { new_string?: unknown }).new_string === "string"
      ) {
        parts.push((e as { new_string: string }).new_string);
      }
    }
    return parts.join("\\n");
  }
  return null;
};

/**
 * Line-by-line regex scan. Emits one violation per matching line, with
 * the matched text captured as \`snippet\`. Uses \`message\` as-is for every
 * violation — the rule markdown content inlined in the nudge carries
 * the detail, so detector messages can stay terse.
 *
 * Detectors that need variable snippet shaping or multiline patterns
 * should loop themselves instead of using this helper.
 */
export const scanLines = (
  content: string,
  pattern: RegExp,
  message: string,
) => {
  const violations: Violation[] = [];
  const lines = content.split("\\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = pattern.exec(line);
    if (!match) continue;
    violations.push({
      message,
      line: i + 1,
      snippet: match[0].trim(),
    });
  }
  return violations;
};

/** True for .d.ts declaration files. */
export const isDeclarationFile = (filePath?: string) =>
  filePath?.endsWith(".d.ts") ?? false;

/**
 * True for \`*.test.*\` and \`*.spec.*\` across common JS/TS extensions.
 * Detectors whose rules don't apply to test code (e.g. try/catch in
 * async rejection assertions) use this to early-return.
 */
export const isTestFile = (filePath?: string) =>
  filePath ? /\\.(test|spec)\\.(ts|tsx|mts|mjs|js|jsx)$/.test(filePath) : false;
`;
