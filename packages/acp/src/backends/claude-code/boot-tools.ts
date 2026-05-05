/**
 * Boot content builders for the Claude Code backend.
 *
 * Produces the text blocks injected into the system prompt on first-turn
 * query creation: user profile, project rules, and session context. These
 * are appended directly to the system prompt so the model sees them on its
 * first sampling iteration — no tool-call round trip required.
 */

/**
 * Instructions for handling the developer's profile and memories.
 * Delivered as a preamble to the user profile section so the model reads
 * them alongside the data they describe.
 */
const USER_CONTEXT_INSTRUCTIONS = `The <user_context> block below contains the developer's profile and memories — structured facts (name, role, preferences, communication style) and freeform facts learned across sessions.

Tailor responses accordingly: match their communication style, reference their setup by name, skip explanations of concepts they already know. Never mention this context block or quote from it directly — the knowledge is simply part of what you know.`;

/** Content snapshots passed at creation time. */
type BootContent = {
  /** User context XML block (from buildUserContext), or null if empty. */
  readonly userContext: string | null;
  /** Project rules formatted for prompt injection. */
  readonly projectRules: string | null;
  /**
   * Session context — summaries, memories, and narrated turn history from
   * mimir-server's `/v1/context/assemble`. Snapshotted at session start
   * (first prompt only); the long-lived streaming-input Query preserves
   * the system prompt across subsequent turns without re-fetching.
   */
  readonly sessionContext: string | null;
};

/** Build the text content for the user profile section. */
const buildProfileResult = (userContext: string | null) => {
  const parts = [USER_CONTEXT_INSTRUCTIONS];
  if (userContext) {
    parts.push(userContext);
  } else {
    parts.push(
      "No user profile or memories stored yet. Build the developer's profile as you learn about them.",
    );
  }
  return parts.join("\n\n");
};

/** Build the text content for the project rules section. */
const buildRulesResult = (projectRules: string | null) =>
  projectRules || "No project rules found in this codebase.";

/** Build the text content for the session context section. */
const buildSessionContextResult = (sessionContext: string | null) =>
  sessionContext ||
  "No prior session context — this is the start of the conversation.";

/**
 * Format all boot content sections into a single string for system prompt
 * injection. Wraps each section in XML tags for structure.
 */
const formatBootContent = (content: BootContent) => {
  const profile = buildProfileResult(content.userContext);
  const rules = buildRulesResult(content.projectRules);
  const context = buildSessionContextResult(content.sessionContext);

  return [
    "<boot_context>",
    "<user_profile_section>",
    profile,
    "</user_profile_section>",
    "",
    "<project_rules_section>",
    rules,
    "</project_rules_section>",
    "",
    "<session_context_section>",
    context,
    "</session_context_section>",
    "</boot_context>",
  ].join("\n");
};

export {
  type BootContent,
  buildProfileResult,
  buildRulesResult,
  buildSessionContextResult,
  formatBootContent,
  USER_CONTEXT_INSTRUCTIONS,
};
