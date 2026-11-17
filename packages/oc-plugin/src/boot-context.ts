/**
 * Boot and per-turn context for OpenCode, on plugin-core's shared boot
 * context (@mimir/plugin-core/brain/boot-context) so the user gets the same
 * leading content regardless of which Mimir adapter they're running.
 *
 * OpenCode hands in its own config and, when it has one, its already-open
 * user-memory store. Failures go to stderr; success logs nothing.
 */

import {
  buildSessionContext,
  assembleBootContext as coreAssembleBootContext,
} from "@mimir/plugin-core/brain/boot-context";
import type { Logger } from "@mimir/plugin-core/logger";
import { activeProjectId } from "@mimir/plugin-core/project/active";
import type { UserMemoryStore } from "@mimir/plugin-core/store/user-memories";
import type { MimirConfig } from "./config";

const STDERR_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message, context) => console.error(message, context),
  error: (message, context) => console.error(message, context),
};

/** Per-prompt retrieval takes retrieveLocalContext's own, smaller defaults. */
const TURN_BUDGETS = {};

export type BootContextOptions = {
  readonly promptText: string;
  readonly projectPath: string;
  readonly config: MimirConfig;
  /** Optional pre-opened user-memory store. Reuse across calls. */
  readonly userMemoryStore?: UserMemoryStore | null;
};

/**
 * Assemble the full `<boot_context>` block with boot-sized retrieval.
 * Errors are logged but never propagated: a partial block (profile
 * populated, session context failed) beats no block at all.
 */
export const assembleBootContext = (opts: BootContextOptions) =>
  coreAssembleBootContext({ ...opts, log: STDERR_LOGGER });

/**
 * The `<retrieved_context>` block for one developer prompt after the
 * first: memories, summaries and playbooks from the local replica matched
 * against the prompt's own text, led by the project id so the model can
 * pass it to the memory tools. Null when nothing matches.
 */
export const retrieveTurnContext = async (opts: BootContextOptions) => {
  const { config, projectPath, promptText } = opts;
  const projectId = await activeProjectId(projectPath, { config });
  const block = await buildSessionContext(
    promptText,
    projectId,
    STDERR_LOGGER,
    TURN_BUDGETS,
  );
  if (!block) return null;
  return projectId ? `<active_project id="${projectId}" />\n${block}` : block;
};
