/**
 * Worker roles — the three persona-less agents a coordinator delegates
 * to. One table, rendered by each host's installer into its native
 * agent-definition format (Claude Code `--agents` JSON, OpenCode agent
 * markdown).
 *
 * The roles are separated so tests can't be edited into passing:
 * `mimir-impl` may not touch tests, `mimir-test` may only touch tests,
 * `mimir-review` touches nothing. The role guard enforces it; the
 * definition only names it.
 */

import type { GuardRole } from "../guard/decision";

export type WorkerRole = Exclude<GuardRole, "coordinator">;

export type WorkerDefinition = {
  /** Agent name as the host sees it (`mimir-impl`). */
  readonly name: string;
  readonly role: WorkerRole;
  /** One line the coordinator's model reads when choosing a worker. */
  readonly description: string;
  /** Tool-use round trips before the host marks the output partial. */
  readonly maxTurns: number;
  /** Tools the host refuses outright, on top of the role guard. */
  readonly disallowedTools: readonly string[];
};

export const WORKER_DEFINITIONS: readonly WorkerDefinition[] = [
  {
    name: "mimir-impl",
    role: "impl",
    description:
      "Implements one scoped change against existing tests. Cannot modify test files; ends with a STATUS line; verification is external.",
    maxTurns: 40,
    disallowedTools: [],
  },
  {
    name: "mimir-test",
    role: "test",
    description:
      "Writes or updates tests for one scoped change (red first). Can only modify test files; ends with a STATUS line.",
    maxTurns: 25,
    disallowedTools: [],
  },
  {
    name: "mimir-review",
    role: "review",
    description:
      "Context-free reviewer: reads a diff cold and reports findings. Read-only; ends with a STATUS line.",
    maxTurns: 25,
    disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
  },
];

export const workerByName = (name: string) =>
  WORKER_DEFINITIONS.find((w) => w.name === name) ?? null;
