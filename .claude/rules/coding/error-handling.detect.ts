/**
 * Mechanical detector for the "Error Handling" rule.
 * Paired with error-handling.md. Flags try/catch blocks in TypeScript
 * source so the agent gets a nudge toward `attempt()` / `.catch(errMessage)`
 * before the edit lands.
 *
 * Scope: .ts/.tsx/.mts/.mjs only. Test files are skipped wholesale because
 * test frameworks legitimately wrap code in try/catch to assert async
 * rejection behaviour (and in bun:test, `expect().rejects` still ends up
 * as try/catch under the hood for certain custom matchers). Declaration
 * files (.d.ts) are skipped because they don't contain implementations.
 *
 * The TypeScript side of error-handling.md is what we enforce here; the
 * Rust and Go sides would need their own sidecars with different regexes
 * (`.unwrap()` and blank `_` error returns respectively). Leaving those
 * for a future pass.
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

// Matches `try {` as a statement — word boundary on `try`, optional
// whitespace, open brace. The word boundary means `retry`, `entry`,
// `country` etc. don't false-match.
const TRY_BLOCK = /\btry\s*\{/;

const shouldScan = (filePath?: string) => {
  if (!filePath) return false;
  if (filePath.endsWith(".d.ts")) return false;
  // Test files legitimately use try/catch for async rejection assertions
  // and other test-harness plumbing. Both .test.* and .spec.* conventions
  // are respected.
  if (/\.(test|spec)\.(ts|tsx|mts|mjs)$/.test(filePath)) return false;
  return /\.(ts|tsx|mts|mjs)$/.test(filePath);
};

const detect = (input: DetectInput) => {
  if (!shouldScan(input.filePath)) return [];
  if (!input.content) return [];

  const violations: Violation[] = [];
  const lines = input.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("try")) continue;
    const match = TRY_BLOCK.exec(line);
    if (!match) continue;
    violations.push({
      message: "try/catch block — see the paired rule for the correct pattern.",
      line: i + 1,
      snippet: match[0].trim(),
    });
  }
  return violations;
};

export default detect;
