/**
 * Condition evaluator for the rule engine.
 *
 * Resolves field names against the tool-call context (e.g. `file_path`,
 * `new_text`, `command`), applies the requested operator (regex_match /
 * contains / equals), and returns either a `ConditionMatch` for a
 * matched condition or `null` for no match. The runner threads every
 * `RuleEntry.conditions[]` through `evaluateCondition` and AND-joins
 * the results.
 *
 * Field semantics intentionally mirror hookify's vocabulary so a rule
 * authored against hookify behaves identically here. `new_text` falls
 * back to `content` and concatenated `edits[].new_string` for Edit /
 * Write / MultiEdit, matching the historical detection-helpers
 * `getIncomingContent` mapping.
 *
 * Regex patterns are pre-compiled at load time (loader.ts), so this
 * module is purely synchronous and never has to deal with malformed
 * patterns at evaluation time.
 */
import type {
  CompiledCondition,
  DetectorContext,
  Violation,
} from "./types";

/**
 * Resolve a field name against the tool-call context. Returns the
 * string value to match against, or `undefined` when the field isn't
 * present for this tool — caller treats undefined as "no match".
 *
 * Recognised fields (cross-backend, hookify-aligned):
 *   file_path / path           — target file path for file-edit tools
 *   new_text / new_string      — incoming content (Edit.new_string,
 *                                Write.content, joined MultiEdit.edits)
 *   old_text / old_string      — Edit.old_string when present
 *   content                    — same as new_text
 *   command                    — Bash command string
 * Anything else is read as a top-level key on `toolInput` if the value
 * is a string. Non-string values are skipped (regex doesn't apply).
 */
export const resolveField = (field: string, ctx: DetectorContext) => {
  const input = ctx.toolInput;
  switch (field) {
    case "file_path":
    case "path": {
      const v = input.file_path ?? input.path;
      return typeof v === "string" ? v : undefined;
    }
    case "new_text":
    case "new_string":
    case "content":
      return resolveIncomingContent(input);
    case "old_text":
    case "old_string": {
      const v = input.old_string ?? input.old_text;
      return typeof v === "string" ? v : undefined;
    }
    case "command": {
      const v = input.command;
      return typeof v === "string" ? v : undefined;
    }
    default: {
      const v = input[field];
      return typeof v === "string" ? v : undefined;
    }
  }
};

/**
 * Same mapping as the historical `getIncomingContent` helper: prefer
 * `new_string` (Edit), then `content` (Write), then concatenated
 * `edits[].new_string` (MultiEdit). Returns undefined for tools that
 * don't carry inbound content (e.g. Bash, Read).
 */
const resolveIncomingContent = (input: Readonly<Record<string, unknown>>) => {
  if (typeof input.new_string === "string") return input.new_string;
  if (typeof input.content === "string") return input.content;
  if (Array.isArray(input.edits)) {
    const parts: string[] = [];
    for (const e of input.edits) {
      if (
        e &&
        typeof e === "object" &&
        "new_string" in e &&
        typeof (e as { new_string: unknown }).new_string === "string"
      ) {
        parts.push((e as { new_string: string }).new_string);
      }
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
};

/**
 * Validate and compile a regex pattern at load time. Returns a result
 * object — `{ regex, error }` discriminator lets the loader collect
 * `LoadError` entries for invalid patterns rather than throwing during
 * the parse pass. Uses `Promise.resolve().then().catch()` instead of
 * try/catch per the project's no-try-catch rule.
 */
export const compileRegex = (pattern: string) =>
  Promise.resolve()
    .then(() => ({
      regex: new RegExp(pattern) as RegExp | null,
      error: null as string | null,
    }))
    .catch((err) => ({
      regex: null as RegExp | null,
      error: err instanceof Error ? err.message : String(err),
    }));

/**
 * Result of a single condition evaluation. `captures` carries the
 * regex capture groups (with the full match at index 0) so the
 * formatter can interpolate `${1}..${9}` and `${match}` into message
 * templates. `equals` and `contains` produce single-element captures.
 */
export interface ConditionMatch {
  readonly violation: Violation;
  readonly captures: readonly string[];
}

/**
 * Evaluate one condition. Returns a `ConditionMatch` on match (carrying
 * the snippet, line number when computable, and the regex captures) or
 * `null` on no match. Synchronous — relies on `condition.regex` being
 * pre-compiled by the loader for `regex_match` operators.
 */
export const evaluateCondition = (
  condition: CompiledCondition,
  ctx: DetectorContext,
) => {
  const value = resolveField(condition.field, ctx);
  if (value === undefined) return null;

  if (condition.operator === "equals") {
    if (value !== condition.pattern) return null;
    return {
      violation: { message: "", snippet: value },
      captures: [value],
    } satisfies ConditionMatch;
  }

  if (condition.operator === "contains") {
    if (!value.includes(condition.pattern)) return null;
    const idx = value.indexOf(condition.pattern);
    return {
      violation: {
        message: "",
        snippet: condition.pattern,
        line: lineOf(value, idx),
      },
      captures: [condition.pattern],
    } satisfies ConditionMatch;
  }

  // regex_match — pre-compiled by loader. A missing regex would mean
  // the loader let an invalid pattern through, which it shouldn't; we
  // skip rather than crash so a logic bug doesn't hijack tool dispatch.
  if (!condition.regex) return null;
  const match = condition.regex.exec(value);
  if (!match) return null;
  return {
    violation: {
      message: "",
      snippet: match[0].trim(),
      line: lineOf(value, match.index),
    },
    captures: [match[0], ...match.slice(1).map((g) => g ?? "")],
  } satisfies ConditionMatch;
};

/** 1-indexed line number of `index` within `value`. */
const lineOf = (value: string, index: number) =>
  value.slice(0, index).split("\n").length;
