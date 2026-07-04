/**
 * First-turn boot-context assembly.
 *
 * On the first developer prompt of a session, prepend a `<boot_context>`
 * XML block to the user message containing:
 *   - <user_profile_section>   from ~/.mimir/user-memories.db
 *   - <session_context_section> from mimir-server /v1/context/assemble
 *
 * Project rules are intentionally NOT in boot — they fire on actual
 * tool-call violations via the PreToolUse hook (rules-hook.ts) where
 * the model only pays the context cost when a rule matches.
 *
 * Mirrors the boot-content shape in packages/acp/src/backends/claude-code/
 * boot-tools.ts so the model sees the same structure regardless of which
 * Mimir transport it's running under.
 */

import { authHeaders, readConfig } from "./config";
import { createLogger } from "./logger";
import { getOrResolveProjectId } from "./project";
import { createUserMemoryStore } from "./store/user-memories";
import { buildUserContext } from "./tools/user-memory";
import { errMessage } from "./util";

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

/**
 * Fetch prior session context from mimir-server's /v1/context/assemble.
 * Returns the formatted `<conversation_context>` block (matching the
 * monorepo's formatContextForPrompt shape), or null when no prior
 * context exists or the fetch fails.
 *
 * `query` doubles as the seed for context-aware retrieval; the
 * developer's first prompt is the natural pick. `project` is the
 * canonical project identifier — we use cwd as a stable handle.
 */
const fetchSessionContext = async (
  serverUrl: string,
  query: string,
  projectPath: string,
  projectId: string | null,
) => {
  const url = `${serverUrl}/v1/context/assemble`;
  const auth = await authHeaders();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      query,
      project: projectPath,
      ...(projectId ? { projectId } : {}),
    }),
  }).catch((err) => {
    log.warn("assemble fetch failed", { error: errMessage(err) });
    return null;
  });
  if (!response?.ok) {
    if (response) {
      log.warn("assemble returned non-OK", { status: response.status });
    }
    return null;
  }

  const payload = (await response.json().catch((err) => {
    log.warn("assemble JSON parse failed", { error: errMessage(err) });
    return null;
  })) as {
    readonly messages?: ReadonlyArray<{
      readonly role: "user" | "assistant";
      readonly content: string;
    }>;
  } | null;

  if (!payload?.messages || payload.messages.length === 0) return null;

  // Drop the last message — that's the current prompt seed, not prior
  // context. ACP does the same (priorMessages = contextMessages.slice(0, -1)).
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
  ).catch(() => null);

  const [profile, sessionContext] = await Promise.all([
    buildUserProfileSection(config.userMemoryDb),
    fetchSessionContext(
      config.serverUrl,
      opts.promptText,
      opts.projectPath,
      projectId,
    ),
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
