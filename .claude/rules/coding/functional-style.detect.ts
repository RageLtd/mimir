/**
 * Mechanical detector for the "Functional Style" rule (CRITICAL).
 * Paired with functional-style.md. Flags top-level `class` declarations.
 *
 * Scope comes from the paired .md frontmatter. `.d.ts` is excluded
 * inline — ambient class declarations in declaration files are
 * legitimate type descriptions. Test files are NOT excluded: the
 * functional-style rule applies everywhere.
 */

import {
  getIncomingContent,
  getToolInput,
  isDeclarationFile,
  type RuleDetectionInput,
  scanLines,
} from "../detection-helpers";

const CLASS_DECL =
  /^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+[A-Z]\w*\b/;

export default (input: RuleDetectionInput) => {
  if (isDeclarationFile(input.filePath)) return [];
  const content = getIncomingContent(getToolInput(input));
  if (!content) return [];
  return scanLines(
    content,
    CLASS_DECL,
    "Class declaration — see the paired rule for the correct pattern.",
  );
};
