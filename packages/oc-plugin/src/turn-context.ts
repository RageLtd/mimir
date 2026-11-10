/**
 * What leads a model request with context from memory.
 *
 * The session's first request gets the boot block (profile plus a
 * boot-sized retrieval against the first prompt). Every later developer
 * prompt gets a turn-sized retrieval against its own text, on that
 * prompt's first request only: the tool rounds that follow belong to the
 * same prompt and would retrieve the same thing.
 *
 * The block is injected into the request, never stored in the session, so
 * extraction does not read retrieved memories back as conversation.
 */

import {
  assembleBootContext,
  type BootContextOptions,
  retrieveTurnContext,
} from "./boot-context";

type Turn = {
  /** True once the session's first request has been served. */
  bootDone: boolean;
  /** Set when a developer prompt is admitted; cleared when it is served. */
  pendingRetrieval: boolean;
};

const operations = { assembleBootContext, retrieveTurnContext };

/** The block to lead this request with, or null. Settles `turn`. */
export const turnContext = async (
  turn: Turn,
  opts: BootContextOptions,
  ops: {
    readonly [K in keyof typeof operations]: (
      opts: BootContextOptions,
    ) => Promise<string | null>;
  } = operations,
) => {
  const isFirst = !turn.bootDone;
  const isDue = turn.pendingRetrieval;
  turn.bootDone = true;
  turn.pendingRetrieval = false;
  if (isFirst) return ops.assembleBootContext(opts);
  if (isDue && opts.promptText.trim().length > 0) {
    return ops.retrieveTurnContext(opts);
  }
  return null;
};
