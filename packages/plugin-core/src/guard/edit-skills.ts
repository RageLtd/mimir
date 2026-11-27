/**
 * The rule that an edit needs its skill loaded: a test file needs
 * `unit-testing`, a source file needs `code-comments` (and `refactor` too
 * in a refactor task), and anything else (docs, config, lockfiles) needs
 * nothing.
 */

import { isTestFile } from "../rules/test-conventions";
import type { GuardDecision } from "./decision";

const UNIT_TESTING = "unit-testing";
const CODE_COMMENTS = "code-comments";
const REFACTOR = "refactor";

const SOURCE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|go|rs|py|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|scala|ex|exs|zig|lua|sh)$/;

/** A loaded skill counts whether it is named bare or plugin-qualified. */
const isLoaded = (skill: string, loaded: readonly string[]) =>
  loaded.some((name) => name === skill || name.endsWith(`:${skill}`));

const TEST_REASON = `Editing a test file needs the ${UNIT_TESTING} skill. Load ${UNIT_TESTING} with the Skill tool, and also integration-testing, end-to-end-testing or ui-testing when the test is that kind, then retry the edit.`;

const SOURCE_REASON = `Editing a source file needs the ${CODE_COMMENTS} skill. Load ${CODE_COMMENTS} with the Skill tool, then retry the edit.`;

const REFACTOR_REASON = `Editing a source file in a refactor task needs the ${REFACTOR} skill. Load ${REFACTOR} with the Skill tool, then retry the edit.`;

const ALLOW: GuardDecision = { allow: true };

/** The skills an edit to `path` needs, each with its refusal, in load order. */
const requiredSkills = (path: string, refactor: boolean) => {
  if (!SOURCE_EXTENSION.test(path)) return [];
  if (isTestFile(path)) return [{ skill: UNIT_TESTING, reason: TEST_REASON }];
  const source = { skill: CODE_COMMENTS, reason: SOURCE_REASON };
  return refactor
    ? [source, { skill: REFACTOR, reason: REFACTOR_REASON }]
    : [source];
};

export const editSkillDecision = (
  path: string,
  loaded: readonly string[],
  { refactor = false }: { readonly refactor?: boolean } = {},
) => {
  const missing = requiredSkills(path, refactor).find(
    ({ skill }) => !isLoaded(skill, loaded),
  );
  const decision: GuardDecision = missing
    ? { allow: false, reason: missing.reason }
    : ALLOW;
  return decision;
};
