/**
 * The skills every host reads as the same SKILL.md: testing, tickets,
 * documentation and refactor. Reference knowledge the model loads when the
 * task calls for it, so each ships as a true skill, not a command the
 * developer runs.
 *
 * There is nothing to render per host: the markdown under ./testing,
 * ./tickets, ./documentation and ./refactor is the source and each plugin's
 * committed copy is that file byte for byte. Edit the source, then run
 * `bun run skills:render`. shared.test.ts fails when a copy drifts.
 */

import codeComments from "./documentation/code-comments.md" with {
  type: "text",
};
import documentation from "./documentation/documentation.md" with {
  type: "text",
};
import refactor from "./refactor/refactor.md" with { type: "text" };
import endToEndTesting from "./testing/end-to-end-testing.md" with {
  type: "text",
};
import integrationTesting from "./testing/integration-testing.md" with {
  type: "text",
};
import uiTesting from "./testing/ui-testing.md" with { type: "text" };
import unitTesting from "./testing/unit-testing.md" with { type: "text" };
import bugTickets from "./tickets/bug-tickets.md" with { type: "text" };
import epicTickets from "./tickets/epic-tickets.md" with { type: "text" };
import storyTickets from "./tickets/story-tickets.md" with { type: "text" };
import taskTickets from "./tickets/task-tickets.md" with { type: "text" };

/** Skill name to its whole SKILL.md. The name is also the folder every host expects. */
export const SHARED_SKILLS: Readonly<Record<string, string>> = {
  "ui-testing": uiTesting,
  "unit-testing": unitTesting,
  "integration-testing": integrationTesting,
  "end-to-end-testing": endToEndTesting,
  "bug-tickets": bugTickets,
  "story-tickets": storyTickets,
  "task-tickets": taskTickets,
  "epic-tickets": epicTickets,
  documentation,
  "code-comments": codeComments,
  refactor,
};

/**
 * The skills directories that ship the copies, from the repository root.
 * OpenCode has none: its installer writes the skills into the user's
 * config.
 */
export const SHARED_SKILL_ROOTS: readonly string[] = [
  "packages/cc-plugin/skills",
  "packages/codex-plugin/skills",
];
