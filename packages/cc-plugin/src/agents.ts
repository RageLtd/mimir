/**
 * Claude Code worker definitions — the `--agents` JSON the wrapper
 * passes at launch, written to ~/.mimir/agents.json by the installer.
 *
 * CLI-defined agents run their frontmatter hooks without the workspace
 * trust dialog, which is why the role guard is wired here per agent
 * rather than in settings.json: the role is static per definition.
 *
 * `isolation: "worktree"` gives each worker its own checkout so parallel
 * workers can't collide and the verify gate can diff against a clean
 * base. No `model` field: every role runs the session's model (MIM-41).
 */

import {
  buildWorkerPrompt,
  WORKER_DEFINITIONS,
} from "@mimir/plugin-core/workers";

const GUARD_TIMEOUT_S = 5;

export type CcAgentDefinition = {
  readonly description: string;
  readonly prompt: string;
  readonly maxTurns: number;
  readonly isolation: "worktree";
  readonly disallowedTools?: readonly string[];
  readonly hooks: {
    readonly PreToolUse: readonly {
      readonly hooks: readonly {
        readonly type: "command";
        readonly command: string;
        readonly timeout: number;
      }[];
    }[];
  };
};

/** Render every worker into the `--agents` map. */
export const renderAgents = (promptXml: string, selfPath: string) => {
  const agents: Record<string, CcAgentDefinition> = {};
  for (const worker of WORKER_DEFINITIONS) {
    agents[worker.name] = {
      description: worker.description,
      prompt: buildWorkerPrompt(promptXml, worker),
      maxTurns: worker.maxTurns,
      isolation: "worktree",
      ...(worker.disallowedTools.length > 0
        ? { disallowedTools: worker.disallowedTools }
        : {}),
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: `${selfPath} guard --role ${worker.role}`,
                timeout: GUARD_TIMEOUT_S,
              },
            ],
          },
        ],
      },
    };
  }
  return agents;
};

export const renderAgentsJson = (promptXml: string, selfPath: string) =>
  `${JSON.stringify(renderAgents(promptXml, selfPath), null, 2)}\n`;
