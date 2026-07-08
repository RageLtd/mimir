/**
 * First-turn boot-context assembly for OpenCode.
 *
 * On the first developer turn of a session, build a `<boot_context>`
 * block containing:
 *   - <user_profile_section>   from ~/.mimir/user-memories.db
 *   - <session_context_section> from the local org replica (MIM-86)
 *
 * Project rules are intentionally NOT in boot — they fire on actual
 * tool-call violations via the rules engine where the model only pays
 * the context cost when a rule matches.
 *
 * Mirrors packages/cc-plugin/src/boot-context.ts so the user gets the
 * same leading content regardless of which Mimir adapter they're
 * running.
 */

import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import { retrieveLocalContext } from "@mimir/plugin-core/brain/retrieve";
import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
} from "@mimir/plugin-core/store/org-replica";
import type { UserMemoryStore } from "@mimir/plugin-core/store/user-memories";
import { buildUserContext } from "@mimir/plugin-core/tools/user-memory";
import { errMessage } from "@mimir/plugin-core/util";
import type { MimirConfig } from "./config";

const USER_CONTEXT_INSTRUCTIONS = `The <user_context> block below contains the developer's profile and memories — structured facts (name, role, preferences, communication style) and freeform facts learned across sessions.

Tailor responses accordingly: match their communication style, reference their setup by name, skip explanations of concepts they already know. Never mention this context block or quote from it directly — the knowledge is simply part of what you know.`;

const buildUserProfileSection = (store: UserMemoryStore) =>
  buildUserContext(store);

// Boot budgets mirror the cc-plugin's (memory topK 10 with related,
// 3 summaries) — richer first-turn priming than per-turn micro-retrieval.
const BOOT_MEMORY_TOP_K = 10;
const BOOT_SUMMARY_COUNT = 3;

/**
 * Build prior session context from the LOCAL org replica (MIM-86) —
 * summaries, memories, and playbooks with boot-sized budgets. Replaces
 * the /v1/context/assemble fetch: reads are local now, so the turn-one
 * boot no longer waits on a server round-trip. Returns null when the
 * replica is missing or empty.
 */
const buildSessionContext = async (query: string, projectId: string | null) => {
  const replicaPath =
    process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath();
  const [openErr, replica] = await attempt(async () =>
    createOrgReplica(replicaPath),
  );
  if (openErr) {
    console.error("replica open failed — no session context", {
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
    console.error("local boot retrieval failed", {
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
  readonly config: MimirConfig;
  /** Optional pre-opened user-memory store. Reuse across calls. */
  readonly userMemoryStore?: UserMemoryStore | null;
};

/**
 * Assemble the full `<boot_context>` block. Returns null when the
 * user-memory store can't be opened and the project ID can't be
 * resolved — caller treats null as "skip injection" and the model
 * runs without the leading context.
 *
 * Errors are logged but never propagated. A partial boot block
 * (profile populated, session context failed) is more useful than
 * no block at all.
 */
export const assembleBootContext = async (opts: BootContextOptions) => {
  const { config, projectPath, promptText } = opts;

  // Resolve project UUID up-front so the local retrieval and the boot
  // block share the same canonical key.
  const projectId = await getOrResolveProjectId(
    config.serverUrl,
    projectPath,
    config.apiKey,
  ).catch(() => null);

  // Open or reuse the user-memory store.
  let store = opts.userMemoryStore ?? null;
  if (!store) {
    try {
      store = (
        await import("@mimir/plugin-core/store/user-memories")
      ).createUserMemoryStore(config.userMemoryDb);
    } catch (err) {
      console.error("user-memory open failed", { error: errMessage(err) });
      store = null;
    }
  }

  const profileBlock = store ? buildUserProfileSection(store) : null;
  const sessionContextBlock = await buildSessionContext(
    promptText,
    projectId,
  ).catch((err) => {
    console.error("session context failed", { error: errMessage(err) });
    return null;
  });

  const profileSection = wrapProfile(profileBlock);
  const sessionContextSection = wrapSessionContext(sessionContextBlock);

  const sections: string[] = ["<boot_context>"];

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

// Re-export for any caller that wants to use the shared user-context
// builder directly.
export { buildUserContext };
