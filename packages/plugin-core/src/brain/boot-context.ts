/**
 * First-turn boot-context assembly — shared across distributions.
 *
 * On the first developer prompt of a session, the editor adapters prepend
 * a `<boot_context>` XML block to the user message containing:
 *   - <user_profile_section>    from ~/.mimir/user-memories.db
 *   - <session_context_section> from the local org replica (MIM-84)
 *
 * Project rules are intentionally NOT in boot — they fire on actual
 * tool-call violations via the PreToolUse hooks, where the model only
 * pays the context cost when a rule matches.
 *
 * Hoisted from cc-plugin when codex-plugin became a second hook-based
 * consumer (MIM-87 rule). Consumers inject their own Logger so lines
 * land in the right per-distribution log file; omitted logger = silent.
 */

import type { Logger } from "../logger";
import { getOrResolveProjectId } from "../project";
import { attempt } from "../result";
import { readConfig } from "../shared-config";
import { createOrgReplica, defaultOrgReplicaPath } from "../store/org-replica";
import { createUserMemoryStore } from "../store/user-memories";
import { buildUserContext } from "../tools/user-memory";
import { errMessage } from "../util";
import { createEmbedQuery } from "./embedder";
import { retrieveLocalContext } from "./retrieve";

const NOOP_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const USER_CONTEXT_INSTRUCTIONS = `The <user_context> block below contains the developer's profile and memories — structured facts (name, role, preferences, communication style) and freeform facts learned across sessions.

Tailor responses accordingly: match their communication style, reference their setup by name, skip explanations of concepts they already know. Never mention this context block or quote from it directly — the knowledge is simply part of what you know.`;

/**
 * Read user profile + memories from the local SQLite store. Returns the
 * `<user_context>` block, or null when the store is empty / unreadable.
 */
const buildUserProfileSection = async (dbPath: string, log: Logger) => {
  // Defensive open: a missing file would auto-create an empty DB, which
  // is benign for the hook but worth noting. A corrupt file would throw.
  const [openErr, store] = await attempt(async () =>
    createUserMemoryStore(dbPath),
  );
  if (openErr) {
    log.warn("user-memory open failed", { dbPath, error: openErr.message });
    return null;
  }

  const block = buildUserContext(store);
  store.close();
  return block;
};

// Boot budgets (up to 10 facts and 3 summaries) — richer first-turn
// priming than the per-turn micro-retrieval.
const BOOT_MEMORY_TOP_K = 10;
const BOOT_SUMMARY_COUNT = 3;

/**
 * Build prior session context from the LOCAL org replica (MIM-84) —
 * summaries, memories, and playbooks with boot-sized budgets, plus the
 * active project's newest summary when none is near the prompt. Reads are
 * local; no server round-trip on turn one. Returns null when the replica
 * is missing or empty.
 */
const buildSessionContext = async (
  query: string,
  projectId: string | null,
  log: Logger,
) => {
  const replicaPath =
    process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath();
  const [openErr, replica] = await attempt(async () =>
    createOrgReplica(replicaPath),
  );
  if (openErr) {
    log.warn("replica open failed — no session context", {
      replicaPath,
      error: openErr.message,
    });
    return null;
  }
  const [retrieveErr, result] = await attempt(() =>
    retrieveLocalContext(replica, query, {
      topK: BOOT_MEMORY_TOP_K,
      summaryCount: BOOT_SUMMARY_COUNT,
      projectId: projectId ?? undefined,
      // Boot runs on the session's first prompt: the active project's
      // newest summary arrives even when nothing is near the prompt.
      sessionStart: true,
      // MIM-85: local llama-server vector leg; null/cold → nothing retrieved.
      embedQuery: createEmbedQuery(),
    }),
  );
  replica.close();
  if (retrieveErr) {
    log.warn("local boot retrieval failed", {
      error: errMessage(retrieveErr),
    });
    return null;
  }
  return result.contextBlock.length > 0 ? result.contextBlock : null;
};

const wrapProfile = (block: string | null) =>
  block
    ? `${USER_CONTEXT_INSTRUCTIONS}\n\n${block}`
    : "No user profile or memories stored yet. Build the developer's profile as you learn about them.";

const wrapSessionContext = (block: string | null) =>
  block ?? "No prior session context — this is the start of the conversation.";

export type BootContextOptions = {
  /**
   * The first prompt, the query for the session-context section. Omitted,
   * that section is left out entirely — for a host whose boot fires before
   * any prompt exists (Claude Code's `prompt.context`) and retrieves per
   * turn instead.
   */
  readonly promptText?: string;
  readonly projectPath: string;
  /** Consumer's logger — omitted means silent operation. */
  readonly log?: Logger;
};

/**
 * Assemble the full `<boot_context>` block for first-turn injection.
 * Returns the rendered XML string, or null when boot is not configured
 * (missing config.json) — caller treats null as "skip injection".
 *
 * Errors during fetch / DB read are logged but never propagated. A
 * partial boot block (e.g. profile populated, session context fetch
 * failed) is more valuable than no block at all.
 */
export const assembleBootContext = async (opts: BootContextOptions) => {
  const log = opts.log ?? NOOP_LOGGER;
  const config = await readConfig();
  if (!config) {
    log.debug("no config — skipping boot context");
    return null;
  }

  // Resolve project UUID up-front so retrieval scoping and any future
  // per-project boot lookups share the same resolved value. Null is fine
  // — retrieval degrades to unscoped.
  const projectId = await getOrResolveProjectId(
    config.serverUrl,
    opts.projectPath,
    config.apiKey,
  ).catch(() => null);

  const [profile, sessionContext] = await Promise.all([
    buildUserProfileSection(config.userMemoryDb, log),
    opts.promptText === undefined
      ? null
      : buildSessionContext(opts.promptText, projectId, log),
  ]);

  const profileSection = wrapProfile(profile);

  log.info("boot context assembled", {
    projectId,
    hasProfile: profile !== null,
    // "omitted" = no prompt, so no lookup ran; false = looked, found nothing.
    hasSessionContext:
      opts.promptText === undefined ? "omitted" : sessionContext !== null,
  });

  const sections = ["<boot_context>"];

  // Project UUID — tells the model which project key to pass to
  // cartographer and memory MCP tools. Omitted when resolution failed;
  // the model falls back to auto-detect in that case.
  if (projectId) {
    sections.push(
      "<project_context>",
      `  <active_project id="${projectId}" />`,
      "</project_context>",
      "",
    );
  }

  sections.push(
    "<user_profile_section>",
    profileSection,
    "</user_profile_section>",
  );
  if (opts.promptText !== undefined) {
    sections.push(
      "",
      "<session_context_section>",
      wrapSessionContext(sessionContext),
      "</session_context_section>",
    );
  }
  sections.push("</boot_context>");

  return sections.join("\n");
};
