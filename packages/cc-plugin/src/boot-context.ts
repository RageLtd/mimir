/**
 * First-turn boot-context assembly.
 *
 * On the first developer prompt of a session, prepend a `<boot_context>`
 * XML block to the user message containing:
 *   - <user_profile_section>   from ~/.mimir/user-memories.db
 *   - <session_context_section> from the local org replica (MIM-84)
 *
 * Project rules are intentionally NOT in boot — they fire on actual
 * tool-call violations via the PreToolUse hook (rules-hook.ts) where
 * the model only pays the context cost when a rule matches.
 *
 * Mirrors the boot-content shape in packages/acp/src/backends/claude-code/
 * boot-tools.ts so the model sees the same structure regardless of which
 * Mimir transport it's running under.
 */

import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import { retrieveLocalContext } from "@mimir/plugin-core/brain/retrieve";
import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
} from "@mimir/plugin-core/store/org-replica";
import { createUserMemoryStore } from "@mimir/plugin-core/store/user-memories";
import { buildUserContext } from "@mimir/plugin-core/tools/user-memory";
import { errMessage } from "@mimir/plugin-core/util";
import { readConfig } from "./config";
import { createLogger } from "./logger";

const log = createLogger("boot-context");

const USER_CONTEXT_INSTRUCTIONS = `The <user_context> block below contains the developer's profile and memories — structured facts (name, role, preferences, communication style) and freeform facts learned across sessions.

Tailor responses accordingly: match their communication style, reference their setup by name, skip explanations of concepts they already know. Never mention this context block or quote from it directly — the knowledge is simply part of what you know.`;

/**
 * Read user profile + memories from the local SQLite store. Returns the
 * `<user_context>` block, or null when the store is empty / unreadable.
 * Logs at debug level on missing path; warn on DB errors so we know
 * when a stale config is silently swallowing context.
 */
const buildUserProfileSection = async (dbPath: string) => {
  // Defensive open: a missing file would auto-create an empty DB, which
  // is benign for the hook but worth noting. A corrupt file would throw.
  const tryOpen = () => {
    try {
      return { ok: true as const, store: createUserMemoryStore(dbPath) };
    } catch (err) {
      log.warn("user-memory open failed", {
        dbPath,
        error: errMessage(err),
      });
      return { ok: false as const };
    }
  };
  const result = tryOpen();
  if (!result.ok) return null;

  const block = buildUserContext(result.store);
  result.store.close();
  return block;
};

// Boot budgets mirror the server /assemble defaults (goldfish retrieval
// topK 10 with related, 3 summaries) — richer first-turn priming than the
// per-turn micro-retrieval.
const BOOT_MEMORY_TOP_K = 10;
const BOOT_SUMMARY_COUNT = 3;

/**
 * Build prior session context from the LOCAL org replica (MIM-84) —
 * summaries, memories, and playbooks with boot-sized budgets. Replaces
 * the /v1/context/assemble fetch: reads are local now, so the turn-one
 * boot no longer waits on a server round-trip (the hook-timeout class
 * this used to trip is gone with it).
 *
 * Divergence from the server path, deliberate: no raw conversation-log
 * replay — the message log stays server-side until MIM-86, and summaries
 * carry the cross-session narrative. Returns null when the replica is
 * missing or empty (run scripts/import-replica.ts to seed).
 */
const buildSessionContext = async (query: string, projectId: string | null) => {
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
      includeRelated: true,
      summaryCount: BOOT_SUMMARY_COUNT,
      projectId: projectId ?? undefined,
      // MIM-85: local llama-server vector leg; null/cold → FTS-only boot.
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
  readonly promptText: string;
  readonly projectPath: string;
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
export const assembleBootContext = async (
  opts: BootContextOptions,
): Promise<string | null> => {
  const config = await readConfig();
  if (!config) {
    log.debug("no config — skipping boot context");
    return null;
  }

  // Resolve project UUID up-front so both /context/assemble and any
  // future per-project boot lookups (e.g. metadata) can share the same
  // resolved value. Null is fine — the assemble endpoint logs only and
  // doesn't filter on projectId.
  const projectId = await getOrResolveProjectId(
    config.serverUrl,
    opts.projectPath,
    config.apiKey,
  ).catch(() => null);

  const [profile, sessionContext] = await Promise.all([
    buildUserProfileSection(config.userMemoryDb),
    buildSessionContext(opts.promptText, projectId),
  ]);

  const profileSection = wrapProfile(profile);
  const sessionContextSection = wrapSessionContext(sessionContext);

  log.info("boot context assembled", {
    projectId,
    hasProfile: profile !== null,
    hasSessionContext: sessionContext !== null,
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
    "",
    "<session_context_section>",
    sessionContextSection,
    "</session_context_section>",
    "</boot_context>",
  );

  return sections.join("\n");
};
