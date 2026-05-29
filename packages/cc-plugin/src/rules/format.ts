/**
 * Findings formatter. Ported verbatim from packages/acp/src/rules/format.ts.
 *
 * Turns a list of `Finding` into the model-facing nudge text injected as
 * `additionalContext` on the PreToolUse hook output. Each rule's body
 * content is inlined when present so the model reads the full rationale
 * alongside the violation. When the rule defines a `message` template,
 * regex captures and per-violation context get interpolated
 * (`${1}..${9}`, `${match}`, `${line}`).
 */
import type { Finding, LoadError, RuleEntry, Violation } from "./types";

/**
 * Format the entire findings list as a single nudge block. Returns
 * null when there are no findings, so the adapter can guard `if (!ctx)
 * return ...` without sentinel-checking an empty string.
 */
export const formatFindings = (findings: ReadonlyArray<Finding>) => {
  if (findings.length === 0) return null;
  const blocks = findings.map(formatFinding);
  return [
    "⚠️ Rule violations detected in your pending edit. Review the rule content below before committing:",
    "",
    blocks.join("\n\n"),
    "",
    "Amend the edit to comply, or explain why the violation is warranted before proceeding.",
  ].join("\n");
};

const formatFinding = (finding: Finding) => {
  const header = finding.rule.body
    ? `Rule: ${finding.rule.id} (${finding.rule.body})`
    : `Rule: ${finding.rule.id}`;
  const bullets = finding.violations.map((v) => formatViolation(v));
  const ruleBlock = finding.rule.bodyContent
    ? [
        "",
        "--- rule content ---",
        finding.rule.bodyContent.trim(),
        "--- end rule ---",
      ]
    : [];
  return [header, ...bullets, ...ruleBlock].join("\n");
};

const formatViolation = (v: Violation) => {
  const linePrefix = typeof v.line === "number" ? `Line ${v.line}: ` : "";
  const snippetSuffix = v.snippet ? ` — \`${v.snippet}\`` : "";
  return `  - ${linePrefix}${v.message}${snippetSuffix}`;
};

/**
 * Render a rule's `message` template with capture groups + per-violation
 * context interpolated. Supported placeholders:
 *   ${match}    → full matched substring (capture[0])
 *   ${1}..${9}  → numbered capture groups (1-indexed)
 *   ${line}     → 1-indexed line number when available
 *
 * Used by the runner when building the per-violation message — pure
 * string substitution, no eval. Unknown placeholders are left intact
 * so a typo in the template surfaces as visible literal text rather
 * than a silent empty string.
 */
export const renderTemplate = (
  template: string,
  captures: readonly string[],
  line: number | undefined,
) => {
  return template
    .replace(/\$\{match\}/g, captures[0] ?? "")
    .replace(/\$\{line\}/g, line === undefined ? "" : String(line))
    .replace(/\$\{(\d)\}/g, (_, n: string) => captures[Number(n)] ?? "");
};

/**
 * Apply a rule's message template (when set) to a violation, otherwise
 * fall back to the literal violation message. The runner uses this to
 * normalize per-violation messages before handing findings to the
 * formatter.
 */
export const applyMessageTemplate = (
  rule: RuleEntry,
  violation: Violation,
  captures: readonly string[],
) => {
  if (!rule.message) return violation;
  return {
    ...violation,
    message: renderTemplate(rule.message, captures, violation.line),
  };
};

/**
 * Format the loader's `LoadError[]` for surfacing at session start —
 * one consolidated message listing every broken `.enforce.toml` so
 * the developer sees them all at once rather than discovering each
 * when the corresponding rule should have fired. Returns null when
 * there are no errors so the caller can guard cleanly.
 */
export const formatLoadErrors = (errors: ReadonlyArray<LoadError>) => {
  if (errors.length === 0) return null;
  const lines = errors.map((e) => {
    const idPart = e.id ? `[${e.id}] ` : "";
    return `  - ${idPart}${e.path}\n      ${e.message}`;
  });
  const noun = errors.length === 1 ? "rule" : "rules";
  return [
    `⚠️ ${errors.length} ${noun} failed to load — they will not enforce until fixed:`,
    "",
    ...lines,
  ].join("\n");
};
