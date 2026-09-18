/**
 * Claude Code worker definitions — the subagent markdown files shipped
 * in the plugin's `agents/` directory. `scripts/render-agents.ts` renders
 * them from the server's system-prompt seed; the files are committed and
 * `agents.test.ts` fails when they drift from the renderer.
 *
 * Shipped in the plugin rather than passed as `--agents`: the plugin
 * directory is what Claude Code re-reads on `/reload-plugins`, on an
 * agent-view respawn and on a desktop resume, and argv survives none of
 * them. Plugin agents cannot carry frontmatter hooks, so the role guard
 * is not wired here — the settings-level `mimir-cc guard` hook derives
 * the role from the payload's `agent_type`.
 *
 * `isolation: "worktree"` gives each worker its own checkout so parallel
 * workers can't collide and the verify gate can diff against a clean
 * base. No `model` field: every role runs the session's model (MIM-41).
 */

import { resolve } from "node:path";
import { toAnthropicXml } from "@mimir/plugin-core/anthropic-xml";
import {
  buildWorkerPrompt,
  WORKER_DEFINITIONS,
  type WorkerDefinition,
} from "@mimir/plugin-core/workers";

/** The seed the server boots its stored prompt from. */
export const PROMPT_SEED = resolve(
  import.meta.dir,
  "..",
  "..",
  "server",
  "system-prompt.md",
);

/** Where Claude Code discovers a plugin's agents. */
export const AGENTS_DIR = resolve(import.meta.dir, "..", "agents");

/**
 * One worker as a subagent markdown file. Frontmatter fields follow the
 * plugins reference: `disallowedTools` is a comma-separated list, the
 * description is JSON-quoted so its punctuation survives YAML.
 */
export const renderAgentMarkdown = (
  worker: WorkerDefinition,
  promptXml: string,
) => {
  const frontmatter = [
    `name: ${worker.name}`,
    `description: ${JSON.stringify(worker.description)}`,
    `maxTurns: ${worker.maxTurns}`,
    "isolation: worktree",
    ...(worker.disallowedTools.length > 0
      ? [`disallowedTools: ${worker.disallowedTools.join(", ")}`]
      : []),
  ];
  return `---\n${frontmatter.join("\n")}\n---\n\n${buildWorkerPrompt(promptXml, worker)}\n`;
};

/** Every worker rendered from the seed, keyed by file name. */
export const renderSeedAgents = async () => {
  const xml = toAnthropicXml(await Bun.file(PROMPT_SEED).text());
  return WORKER_DEFINITIONS.map((worker) => ({
    file: `${worker.name}.md`,
    content: renderAgentMarkdown(worker, xml),
  }));
};
