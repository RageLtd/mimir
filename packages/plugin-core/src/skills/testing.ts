/**
 * The testing skills — how to think about UI, unit, integration and
 * end-to-end tests. Reference knowledge the model loads when the task is
 * a test, in the session and in the test and review workers alike, so
 * each ships as a true skill, not a command the developer runs.
 *
 * Every host reads the same SKILL.md, so there is nothing to render per
 * host: the markdown under ./testing is the source and each plugin's
 * committed copy is that file byte for byte. Edit the source, then run
 * `bun run skills:render`. testing.test.ts fails when a copy drifts.
 */

import endToEndTesting from "./testing/end-to-end-testing.md" with {
  type: "text",
};
import integrationTesting from "./testing/integration-testing.md" with {
  type: "text",
};
import uiTesting from "./testing/ui-testing.md" with { type: "text" };
import unitTesting from "./testing/unit-testing.md" with { type: "text" };

/** Skill name to its whole SKILL.md. The name is also the folder every host expects. */
export const TESTING_SKILLS: Readonly<Record<string, string>> = {
  "ui-testing": uiTesting,
  "unit-testing": unitTesting,
  "integration-testing": integrationTesting,
  "end-to-end-testing": endToEndTesting,
};

/**
 * The skills directories that ship the copies, from the repository root.
 * OpenCode has none: its installer writes the skills into the user's
 * config.
 */
export const TESTING_SKILL_ROOTS: readonly string[] = [
  "packages/cc-plugin/skills",
  "packages/codex-plugin/skills",
];
