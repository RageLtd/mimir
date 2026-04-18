/**
 * Mechanical detector for the "Functional Style" rule (CRITICAL).
 * Paired with functional-style.md. Flags top-level `class` declarations
 * in TypeScript/JavaScript source so the agent gets a nudge toward plain
 * objects, closures, and module-level functions.
 *
 * Scope: .ts/.tsx/.mts/.mjs/.js/.jsx only. `.d.ts` files are skipped —
 * ambient class declarations in declaration files are legitimate type
 * descriptions, not implementations. Test files are NOT skipped: the
 * functional-style rule applies everywhere, not just in production code.
 *
 * The regex intentionally does not match `declare class` (that's a type
 * declaration, functionally equivalent to an interface) because `declare`
 * isn't in the allowed prefix set. Decorators on the previous line don't
 * affect matching — we scan line-by-line and the `class Foo {` line still
 * matches on its own.
 */

interface DetectInput {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly filePath?: string;
  readonly content?: string;
}

interface Violation {
  readonly message: string;
  readonly line?: number;
  readonly snippet?: string;
}

// Matches top-level `class Foo` optionally preceded by `export` and/or
// `abstract`. Requires PascalCase name to cut down false positives on
// things like `const className = ...`. Does NOT match `declare class`,
// `interface`, or `type` declarations.
const CLASS_DECL =
  /^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+[A-Z]\w*\b/;

const shouldScan = (filePath?: string) => {
  if (!filePath) return false;
  if (filePath.endsWith(".d.ts")) return false;
  return /\.(ts|tsx|mts|mjs|js|jsx)$/.test(filePath);
};

const detect = (input: DetectInput) => {
  if (!shouldScan(input.filePath)) return [];
  if (!input.content) return [];

  const violations: Violation[] = [];
  const lines = input.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Short-circuit: the keyword `class` must appear at all.
    if (!line.includes("class")) continue;
    const match = CLASS_DECL.exec(line);
    if (!match) continue;
    violations.push({
      message:
        "Class declaration — see the paired rule for the correct pattern.",
      line: i + 1,
      snippet: match[0].trim(),
    });
  }
  return violations;
};

export default detect;
