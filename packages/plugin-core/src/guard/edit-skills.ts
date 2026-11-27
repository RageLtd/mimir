/**
 * The rule that an edit needs its skills loaded: a test file needs
 * `unit-testing`, a source file needs `code-comments` and `less-code` (and
 * `refactor` too in a refactor task), and anything else (docs, config,
 * lockfiles) needs nothing. A refusal names every skill still missing for
 * the edit, so one refusal is enough to load them all.
 */

import { isTestFile } from "../rules/test-conventions";
import type { GuardDecision } from "./decision";

const UNIT_TESTING = "unit-testing";
const CODE_COMMENTS = "code-comments";
const LESS_CODE = "less-code";
const REFACTOR = "refactor";

const SOURCE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|go|rs|py|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|scala|ex|exs|zig|lua|sh)$/;

/** A loaded skill counts whether it is named bare or plugin-qualified. */
const isLoaded = (skill: string, loaded: readonly string[]) =>
  loaded.some((name) => name === skill || name.endsWith(`:${skill}`));

const TEST_REASON = `Editing a test file needs the ${UNIT_TESTING} skill. Load ${UNIT_TESTING} with the Skill tool, and also integration-testing, end-to-end-testing or ui-testing when the test is that kind, then retry the edit.`;

const ALLOW: GuardDecision = { allow: true };

/** "a", "a and b", "a, b and c". */
const listOf = (names: readonly string[]) =>
  names.length === 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const sourceReason = (missing: readonly string[], refactor: boolean) => {
  const task = refactor ? " in a refactor task" : "";
  const skills = missing.length === 1 ? "skill" : "skills";
  const them = missing.length === 1 ? "it" : "them";
  return `Editing a source file${task} needs the ${listOf(missing)} ${skills}. Load ${them} with the Skill tool, then retry the edit.`;
};

export const editSkillDecision = (
  path: string,
  loaded: readonly string[],
  { refactor = false }: { readonly refactor?: boolean } = {},
) => {
  if (!SOURCE_EXTENSION.test(path)) return ALLOW;
  if (isTestFile(path)) {
    const decision: GuardDecision = isLoaded(UNIT_TESTING, loaded)
      ? ALLOW
      : { allow: false, reason: TEST_REASON };
    return decision;
  }
  const required = refactor
    ? [CODE_COMMENTS, LESS_CODE, REFACTOR]
    : [CODE_COMMENTS, LESS_CODE];
  const missing = required.filter((skill) => !isLoaded(skill, loaded));
  const decision: GuardDecision =
    missing.length === 0
      ? ALLOW
      : { allow: false, reason: sourceReason(missing, refactor) };
  return decision;
};
