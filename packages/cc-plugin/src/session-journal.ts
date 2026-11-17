/**
 * The binary's handle on the session journal (plugin-core
 * `store/session-journal`): where it lives, how long an idle session's
 * journal is kept, and what the hook runs do with it — `persist`,
 * `precompact` and `session-end` append what they were handed; `precompact`
 * and the session-end worker read the uncovered journal back as the
 * summary's input and settle it once a summary is stored; the session-start
 * worker prunes. Journal trouble is a logged warning: a write that fails
 * changes nothing else, and a read that fails leaves the run with nothing
 * to summarise.
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";
import { attemptSync } from "@mimir/plugin-core/result";
import {
  createSessionJournal,
  defaultSessionJournalPath,
} from "@mimir/plugin-core/store/session-journal";
import { type ApiMessage, toModelMessages } from "./conversation";
import { createLogger } from "./logger";

const log = createLogger("session-journal");

/** A session's journal not written for this long is pruned. */
export const SESSION_JOURNAL_MAX_IDLE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Leads the previous summary when it opens the next summary's input. */
export const CARRIED_SUMMARY_LABEL =
  "Summary of this session before the last compaction:";

export const sessionJournalPath = () =>
  process.env.MIMIR_SESSION_JOURNAL_DB ?? defaultSessionJournalPath();

/** Runs `use` against an open journal, closing it after; returns what `use`
 *  returned, or null when opening or `use` failed — logged under `what`. */
const withJournal = <T>(
  what: string,
  use: (journal: ReturnType<typeof createSessionJournal>) => T,
  context: Record<string, unknown>,
) => {
  const path = sessionJournalPath();
  const [openErr, journal] = attemptSync(() => createSessionJournal(path));
  if (openErr) {
    log.warn(`session journal could not be opened — ${what} skipped`, {
      ...context,
      path,
      error: openErr.message,
    });
    return null;
  }
  const [useErr, result] = attemptSync(() => use(journal));
  journal.close();
  if (useErr) {
    log.warn(`session journal ${what} failed`, {
      ...context,
      path,
      error: useErr.message,
    });
    return null;
  }
  return result;
};

/** Appends the messages a run was handed, as the hook sent them. */
export const journalMessages = (
  sessionId: string,
  messages: readonly unknown[],
) => {
  withJournal(
    "append",
    (journal) => {
      journal.append(sessionId, messages);
    },
    { sessionId, messages: messages.length },
  );
};

// The journal holds what the hooks module sent; a row of another shape is
// left out of the summary rather than failing the read.
const isApiMessage = (value: unknown): value is ApiMessage =>
  typeof value === "object" &&
  value !== null &&
  "role" in value &&
  (value.role === "user" || value.role === "assistant") &&
  "content" in value &&
  Array.isArray(value.content);

/**
 * The session's summary input from its uncovered journal: the carried
 * summary first, labelled, then the uncovered messages; with the cursor a
 * settle needs. No uncovered message leaves the input empty — the carried
 * summary alone is nothing new. Null when the journal cannot be read.
 */
export const readSummaryInput = (sessionId: string) =>
  withJournal(
    "read",
    (journal) => {
      const read = journal.readUncovered(sessionId);
      const uncovered = toModelMessages(read.messages.filter(isApiMessage));
      const carried: ModelMessage[] =
        uncovered.length > 0 && read.carried !== null
          ? [
              {
                role: "user",
                content: `${CARRIED_SUMMARY_LABEL}\n${read.carried}`,
              },
            ]
          : [];
      return { messages: [...carried, ...uncovered], cursor: read.cursor };
    },
    { sessionId },
  );

/** Marks the session covered through `cursor`, carrying the stored summary. */
export const settleJournal = (
  sessionId: string,
  cursor: number,
  text: string,
) => {
  withJournal(
    "settle",
    (journal) => {
      journal.settle(sessionId, cursor, text);
    },
    { sessionId, cursor },
  );
};

/** Drops every session idle past `SESSION_JOURNAL_MAX_IDLE_DAYS`. */
export const pruneIdleJournals = () => {
  withJournal(
    "prune",
    (journal) => {
      journal.prune(SESSION_JOURNAL_MAX_IDLE_DAYS * DAY_MS);
    },
    { maxIdleDays: SESSION_JOURNAL_MAX_IDLE_DAYS },
  );
};
