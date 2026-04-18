/**
 * Mechanical detector for the "No Explicit Return Type Annotations" rule.
 * Paired with return-types.md. Mimir loads this sidecar at session start
 * and runs it on every Edit/Write/MultiEdit call via a PreToolUse hook.
 *
 * Detection strategy: line-by-line regex scan for patterns shaped like
 * `): Type =>` or `): Type {` — the common forms of explicit return type
 * annotations on arrow functions and function/method declarations.
 *
 * Scope: only .ts/.tsx/.mts/.mjs files. Skips .d.ts (declarations are the
 * entire point of those files) and test files (looser boundary).
 *
 * Known false positives: method signatures inside `interface` / `type`
 * blocks. The rule permits annotations there (external contracts), but
 * untangling them requires AST parsing. A nudge is cheap and advisory —
 * the human distinguishes easily from context. Detector stays regex-only.
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

// Matches `): <type> =>` or `): <type> {`. Two forms of the type
// expression are covered:
//   1. Inline object / tuple / callback type: `{...}`, `[...]`, `(...)`.
//      Balanced-brace matching is approximated by allowing the inner
//      content to span multiple lines until the matching close.
//   2. Named type: `Foo`, `Promise<T>`, `A | B`, etc. — starts with an
//      identifier character.
// The type expression is then followed by `=>` (arrow function) or `{`
// (function/method body). End-of-statement forms like `): T;` or `): T,`
// are intentionally skipped — those are type declarations, not
// implementations, and fall under the rule's exception clause.
const RETURN_TYPE =
  /\)\s*:\s*(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_][\w<>\s,|&[\]?{}()]*?)\s*(=>|\{)/;

const shouldScan = (filePath?: string) => {
  if (!filePath) return false;
  if (filePath.endsWith(".d.ts")) return false;
  if (/\.test\.(ts|tsx|mts|mjs)$/.test(filePath)) return false;
  return /\.(ts|tsx|mts|mjs)$/.test(filePath);
};

const detect = (input: DetectInput) => {
  if (!shouldScan(input.filePath)) return [];
  if (!input.content) return [];

  const violations: Violation[] = [];
  const lines = input.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip trivially non-function lines — cheap short-circuit.
    if (!line.includes("):")) continue;
    const match = RETURN_TYPE.exec(line);
    if (!match) continue;
    violations.push({
      message:
        "Explicit return type annotation — see the paired rule for the correct pattern.",
      line: i + 1,
      snippet: match[0].trim(),
    });
  }
  return violations;
};

export default detect;
