/**
 * Mechanical detector for the "Dependency Management" rule (CRITICAL).
 * Paired with dependencies.md.
 *
 * Scope: the paired .md frontmatter declares manifest globs, so this
 * detector only runs on package.json / Cargo.toml / go.mod / pyproject.toml.
 * From there it scans the incoming content for dependency-section signals
 * and flags any edit that touches them.
 */

import {
  getIncomingContent,
  getToolInput,
  type RuleDetectionInput,
  type Violation,
} from "../detection-helpers";

/** Per-manifest patterns that strongly indicate a dependency-section touch. */
const DEP_SIGNALS: Record<string, RegExp[]> = {
  "package.json": [
    /"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:/,
    /"[^"]+"\s*:\s*"(?:\^|~|>=|<=|=|>|<)?\d/,
  ],
  "Cargo.toml": [
    /\[(?:dependencies|dev-dependencies|build-dependencies|workspace\.dependencies)\]/,
    /^\s*[\w-]+\s*=\s*"[\d.~^*<>=]/m,
  ],
  "go.mod": [/^\s*require\s+/m, /^\s*[\w./-]+\s+v\d+\.\d+/m],
  "pyproject.toml": [
    /\[(?:tool\.poetry\.dependencies|project\.dependencies|tool\.uv\.sources)\]/,
    /^\s*[\w-]+\s*=\s*["'\d]/m,
    /^\s*"[\w-]+[><=~]/m,
  ],
};

const manifestKind = (filePath: string) => {
  if (filePath.endsWith("package.json")) return "package.json";
  if (filePath.endsWith("Cargo.toml")) return "Cargo.toml";
  if (filePath.endsWith("go.mod")) return "go.mod";
  if (filePath.endsWith("pyproject.toml")) return "pyproject.toml";
  return null;
};

export default (input: RuleDetectionInput) => {
  if (!input.filePath) return [];
  const kind = manifestKind(input.filePath);
  if (!kind) return [];
  const content = getIncomingContent(getToolInput(input));
  if (!content) return [];

  const signals = DEP_SIGNALS[kind] ?? [];
  const violations: Violation[] = [];
  for (const re of signals) {
    const match = re.exec(content);
    if (match) {
      const line = content.slice(0, match.index).split("\n").length;
      violations.push({
        message: `Direct edit to ${kind} dependency section — use the package manager CLI instead (see paired rule).`,
        line,
        snippet: match[0].slice(0, 80).trim(),
      });
      // Single violation per tool call is enough to nudge — don't spam.
      return violations;
    }
  }
  return violations;
};
