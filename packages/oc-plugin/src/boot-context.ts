/**
 * First-turn boot-context assembly for OpenCode.
 *
 * On the first developer turn of a session, build a `<boot_context>`
 * block containing:
 *   - <user_profile_section>   from ~/.mimir/user-memories.db
 *   - <session_context_section> from mimir-server /v1/context/assemble
 *
 * Project rules are intentionally NOT in boot — they fire on actual
 * tool-call violations via the rules engine where the model only pays
 * the context cost when a rule matches.
 *
 * Mirrors packages/cc-plugin/src/boot-context.ts so the user gets the
 * same leading content regardless of which Mimir adapter they're
 * running.
 */

import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import type { UserMemoryStore } from "@mimir/plugin-core/store/user-memories";
import { buildUserContext } from "@mimir/plugin-core/tools/user-memory";
import { errMessage } from "@mimir/plugin-core/util";
import { authHeaders, type MimirConfig } from "./config";

const USER_CONTEXT_INSTRUCTIONS = `The <user_context> block below contains the developer's profile and memories — structured facts (name, role, preferences, communication style) and freeform facts learned across sessions.

Tailor responses accordingly: match their communication style, reference their setup by name, skip explanations of concepts they already know. Never mention this context block or quote from it directly — the knowledge is simply part of what you know.`;

const ASSEMBLE_ROUTE = "/v1/context/assemble";

type AssembleResponse = {
  readonly messages?: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly content: string;
  }>;
};

const buildUserProfileSection = (store: UserMemoryStore): string | null => {
  return buildUserContext(store);
};

const fetchSessionContext = async (
  config: MimirConfig,
  query: string,
  project: string,
  projectId: string | null,
): Promise<string | null> => {
  const url = `${config.serverUrl}${ASSEMBLE_ROUTE}`;
  const auth = await authHeaders();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      query,
      project,
      ...(projectId ? { projectId } : {}),
    }),
  }).catch((err) => {
    console.error("assemble fetch failed", { error: errMessage(err) });
    return null;
  });
  if (!response?.ok) {
    return null;
  }
  const payload = (await response
    .json()
    .catch(() => null)) as AssembleResponse | null;
  if (!payload?.messages || payload.messages.length === 0) return null;

  // Drop the last message — that's the current prompt seed, not prior
  // context. Mirrors the cc-plugin's behavior.
  const prior = payload.messages.slice(0, -1);
  if (prior.length === 0) return null;

  const lines = prior.map(
    (m) => `[${m.role === "user" ? "User" : "Assistant"}]\n${m.content}`,
  );
  return `<conversation_context>\n${lines.join("\n\n")}\n</conversation_context>`;
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
export const assembleBootContext = async (
  opts: BootContextOptions,
): Promise<string | null> => {
  const { config, projectPath, promptText } = opts;

  // Resolve project UUID up-front so both /context/assemble and the
  // boot block share the same canonical key.
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
  const sessionContextBlock = await fetchSessionContext(
    config,
    promptText,
    projectPath,
    projectId,
  ).catch((err) => {
    console.error("assemble fetch failed", { error: errMessage(err) });
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
