/**
 * OpenCode worker agent files — `~/.config/opencode/agents/mimir-*.md`,
 * written by the installer from the shared worker definitions.
 *
 * Frontmatter carries the coarse, native permission layer: OpenCode
 * evaluates its `permission` rules itself, before any plugin runs, and
 * matches patterns with `*` that crosses `/`. Insertion order matters
 * (last matching rule wins), so the broad rule always comes first. The
 * role guard in `worker-hooks.ts` is the precise layer on top.
 *
 * The body is the shared worker prompt: the working sections of the
 * installed Mimir prompt plus the role contract — no persona.
 */

import { SECRET_PATH_GLOBS } from "@mimir/plugin-core/guard";
import { markdownToXml } from "@mimir/plugin-core/markdown-to-xml";
import type { WorkerRoleModels } from "@mimir/plugin-core/shared-config";
import {
  buildWorkerPrompt,
  TEST_PATH_GLOBS,
  WORKER_DEFINITIONS,
  type WorkerDefinition,
} from "@mimir/plugin-core/workers";

type Action = "allow" | "deny" | "ask";
type Rules = readonly (readonly [pattern: string, action: Action])[];

const DESTRUCTIVE_GIT: Rules = [
  ["git push*", "deny"],
  ["git reset --hard*", "deny"],
  ["git branch -D*", "deny"],
  ["git clean -f*", "deny"],
];

const REVIEW_BASH: Rules = [
  ["*", "deny"],
  ["git diff*", "allow"],
  ["git log*", "allow"],
  ["git show*", "allow"],
  ["git status*", "allow"],
  ["git blame*", "allow"],
];

const withDefault = (
  first: Action,
  rest: readonly string[],
  action: Action,
) => {
  const rules: Rules = [["*", first], ...rest.map((g) => [g, action] as const)];
  return rules;
};

const secretReads = () => withDefault("allow", SECRET_PATH_GLOBS, "deny");

const editRules = (role: WorkerDefinition["role"]) => {
  switch (role) {
    case "impl":
      return withDefault("allow", TEST_PATH_GLOBS, "deny");
    case "test":
      return withDefault("deny", TEST_PATH_GLOBS, "allow");
    case "review":
      return withDefault("deny", [], "deny");
    default:
      return assertNever(role);
  }
};

const assertNever = (value: never) => {
  throw new Error(`Unhandled worker role: ${String(value)}`);
};

const yamlKey = (pattern: string) => JSON.stringify(pattern);

const renderRules = (name: string, rules: Rules) =>
  [`  ${name}:`, ...rules.map(([p, a]) => `    ${yamlKey(p)}: ${a}`)].join(
    "\n",
  );

/** Frontmatter for one worker. `model` (MIM-41) pins this agent to one
 *  provider/model id; omitted entirely when unset, so OpenCode falls back
 *  to the session's default agent model. */
export const renderWorkerFrontmatter = (
  worker: WorkerDefinition,
  model?: string,
) =>
  [
    "---",
    `description: ${JSON.stringify(worker.description)}`,
    "mode: subagent",
    ...(model ? [`model: ${JSON.stringify(model)}`] : []),
    `steps: ${worker.maxTurns}`,
    "permission:",
    "  task: deny",
    renderRules("edit", editRules(worker.role)),
    renderRules(
      "bash",
      worker.role === "review"
        ? REVIEW_BASH
        : [["*", "allow"], ...DESTRUCTIVE_GIT],
    ),
    renderRules("read", secretReads()),
    "---",
  ].join("\n");

/** Full agent file for one worker. `promptMarkdown` is the installed Mimir prompt. */
export const renderWorkerAgent = (
  worker: WorkerDefinition,
  promptMarkdown: string,
  model?: string,
) =>
  `${renderWorkerFrontmatter(worker, model)}\n\n${buildWorkerPrompt(markdownToXml(promptMarkdown), worker)}\n`;

/** Every worker, keyed by filename (`mimir-impl.md`). `models` is the
 *  opencode namespace of the config's per-role worker models (MIM-41);
 *  a role it omits renders without a model key. */
export const renderWorkerAgents = (
  promptMarkdown: string,
  models: WorkerRoleModels = {},
) => {
  const files: Record<string, string> = {};
  for (const worker of WORKER_DEFINITIONS) {
    files[`${worker.name}.md`] = renderWorkerAgent(
      worker,
      promptMarkdown,
      models[worker.role],
    );
  }
  return files;
};
