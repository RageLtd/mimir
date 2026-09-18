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

/**
 * Claude Code reports plugin-shipped agents as `<plugin>:<name>` in
 * hook payloads (`mimir-cc:mimir-test`); the bare name is what the
 * definitions carry, so the prefix is dropped before matching.
 */
const bareName = (name: string) => name.slice(name.lastIndexOf(":") + 1);

export const workerByName = (name: string) =>
  WORKER_DEFINITIONS.find((w) => w.name === bareName(name)) ?? null;

/**
 * The verify-gate role for an agent type. Unknown types (a host's
 * built-in subagent, say) get `impl` — the strictest — so an unnamed
 * worker is still gated.
 */
export const roleForAgentType = (agentType: string | undefined) => {
  const role: WorkerRole = workerByName(agentType ?? "")?.role ?? "impl";
  return role;
};

/**
 * Test paths as host permission wildcards (`*` matches across `/`),
 * for hosts whose native permission layer wants globs. A coarse
 * approximation of the `test-conventions` table; the role guard is
 * the precise layer on top.
 */
export const TEST_PATH_GLOBS: readonly string[] = [
  "*.test.*",
  "*.spec.*",
  "*_test.go",
  "test_*.py",
  "*_test.py",
  "tests/*",
  "*/tests/*",
  "__tests__/*",
  "*/__tests__/*",
  "*/src/test/*",
  "*Test.java",
  "*Tests.java",
  "*Spec.kt",
  "*Test.kt",
  "*Spec.scala",
  "*_test.exs",
  "*_spec.rb",
  "*_test.rb",
  "*Test.cs",
  "*Tests.cs",
];
