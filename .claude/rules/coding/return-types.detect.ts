/**
 * Mechanical detector for the "No Explicit Return Type Annotations" rule.
 * Paired with return-types.md.
 *
 * Scope comes from the paired .md frontmatter — rule-hooks filters by
 * `globs` and `tools` before invoking this function. `.d.ts` and
 * `*.test.*` are excluded inline because glob frontmatter can't negate.
 */

import {
  getIncomingContent,
  getToolInput,
  isDeclarationFile,
  isTestFile,
  type RuleDetectionInput,
  scanLines,
} from "../detection-helpers";

// Matches `): <type> =>` or `): <type> {`. Type can be an inline object,
// tuple, or named form; lazy capture stops at the first `=>` or `{`.
const RETURN_TYPE =
  /\)\s*:\s*(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_][\w<>\s,|&[\]?{}()]*?)\s*(=>|\{)/;

export default (input: RuleDetectionInput) => {
  if (isDeclarationFile(input.filePath)) return [];
  if (isTestFile(input.filePath)) return [];
  const content = getIncomingContent(getToolInput(input));
  if (!content) return [];
  return scanLines(
    content,
    RETURN_TYPE,
    "Explicit return type annotation — see the paired rule for the correct pattern.",
  );
};
