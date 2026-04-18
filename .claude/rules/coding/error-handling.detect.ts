/**
 * Mechanical detector for the "Error Handling" rule.
 * Paired with error-handling.md.
 *
 * Scope comes from the paired .md frontmatter. Test files and `.d.ts`
 * declarations are excluded inline — tests legitimately use try/catch
 * for async rejection assertions, and declarations are pure type shape.
 */

import {
  getIncomingContent,
  getToolInput,
  isDeclarationFile,
  isTestFile,
  type RuleDetectionInput,
  scanLines,
} from "../detection-helpers";

const TRY_BLOCK = /\btry\s*\{/;

export default (input: RuleDetectionInput) => {
  if (isDeclarationFile(input.filePath)) return [];
  if (isTestFile(input.filePath)) return [];
  const content = getIncomingContent(getToolInput(input));
  if (!content) return [];
  return scanLines(
    content,
    TRY_BLOCK,
    "try/catch block — see the paired rule for the correct pattern.",
  );
};
