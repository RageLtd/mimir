/**
 * The ticket skills — how to write, update and review bug, story, task
 * and epic tickets. Reference knowledge the model loads when the task is
 * a ticket, so each ships as a true skill, not a command the developer
 * runs.
 *
 * Every host reads the same SKILL.md, so there is nothing to render per
 * host: the markdown under ./tickets is the source and each plugin's
 * committed copy is that file byte for byte. Edit the source, then run
 * `bun run skills:render`. tickets.test.ts fails when a copy drifts.
 */

import bugTickets from "./tickets/bug-tickets.md" with { type: "text" };
import epicTickets from "./tickets/epic-tickets.md" with { type: "text" };
import storyTickets from "./tickets/story-tickets.md" with { type: "text" };
import taskTickets from "./tickets/task-tickets.md" with { type: "text" };

/** Skill name to its whole SKILL.md. The name is also the folder every host expects. */
export const TICKET_SKILLS: Readonly<Record<string, string>> = {
  "bug-tickets": bugTickets,
  "story-tickets": storyTickets,
  "task-tickets": taskTickets,
  "epic-tickets": epicTickets,
};

/**
 * The skills directories that ship the copies, from the repository root.
 * OpenCode has none: its installer writes the skills into the user's
 * config.
 */
export const TICKET_SKILL_ROOTS: readonly string[] = [
  "packages/cc-plugin/skills",
  "packages/codex-plugin/skills",
];
