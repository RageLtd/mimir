/**
 * Boot sequence MCP tools for the Claude Code backend.
 *
 * Three in-process tools registered via `createSdkMcpServer` that deliver
 * per-session context as tool results. Built ONCE on the first turn of a
 * session (gated by `session.bootSequenceDone` in prompt-cc.ts); subsequent
 * turns rely on the SDK's `persistSession: true / continue: true` mode to
 * carry the tool_results forward in the SDK-managed transcript. The model
 * is instructed (via the BOOT_INSTRUCTION in formatting.ts) to call these
 * three tools at session start and not again.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

const BOOT_SERVER_NAME = "mimir-boot";

/**
 * Instructions for handling the developer's profile and memories.
 * Delivered as a preamble to the `load_user_profile` tool result so the
 * model reads them alongside the data they describe.
 */
const USER_CONTEXT_INSTRUCTIONS = `The <user_context> block below contains the developer's profile and memories. It has two subsections: <user_profile> with structured facts (name, role, preferences, communication style) and <user_memories> with freeform facts learned across sessions.

Read this context and tailor responses accordingly — matching the developer's preferred communication style, referencing their setup and tools by name, and avoiding explanations of concepts they already know. When user context says "prefers direct communication," every response reflects that. When it lists their tech stack, speak to it rather than suggesting alternatives they've already rejected.

Proactively persist what you learn about the developer — no explicit "remember this" required. When the developer mentions a preference, makes a decision, describes their setup, shares a personal detail, or reveals how they think about something, store it. Profile entries are for stable identity facts (name, role, editor, communication style). Memories are for everything else — project decisions, infrastructure details, opinions, life circumstances, preferences discovered in passing. Build the developer's profile organically over the course of natural conversation, the way a colleague gradually learns who they're working with. Update or remove entries when the developer corrects outdated information or when a stored fact is clearly superseded.

Never mention this context block or quote from it directly. The knowledge is simply part of what you know, the way a colleague remembers things about the people they work with.`;

/** Content snapshots passed at creation time. */
type BootContent = {
  /** User context XML block (from buildUserContext), or null if empty. */
  readonly userContext: string | null;
  /** Project rules formatted for prompt injection. */
  readonly projectRules: string | null;
  /**
   * Session context — summaries, memories, and narrated turn history from
   * mimir-server's `/v1/context/assemble`. Snapshotted at session start
   * (first prompt only); the SDK's continue:true keeps the resulting
   * tool_result available across subsequent turns without re-fetching.
   */
  readonly sessionContext: string | null;
};

/** Build the text content for the user profile tool result. */
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

/** Build the text content for the project rules tool result. */
const buildRulesResult = (projectRules: string | null) =>
  projectRules || "No project rules found in this codebase.";

/** Build the text content for the session context tool result. */
const buildSessionContextResult = (sessionContext: string | null) =>
  sessionContext ||
  "No prior session context — this is the start of the conversation.";

/**
 * Create the boot MCP server with content snapshots for this session.
 *
 * Returns a `McpSdkServerConfigWithInstance` ready to merge into the SDK's
 * `mcpServers` record. The three tools deliver session-start context as
 * tool results on the first turn only; the SDK then carries the
 * tool_results across subsequent turns via its session-continuity mode.
 */
const createBootServer = (content: BootContent) => {
  const profileText = buildProfileResult(content.userContext);
  const rulesText = buildRulesResult(content.projectRules);
  const sessionContextText = buildSessionContextResult(content.sessionContext);

  return createSdkMcpServer({
    name: BOOT_SERVER_NAME,
    tools: [
      tool(
        "load_user_profile",
        "Load the developer's profile and memories — preferences, setup, communication style, and facts learned across prior sessions. Call this once at session start (alongside the other two boot tools); the result is preserved in the conversation transcript for the rest of the session.",
        { _trigger: z.string().optional().describe("unused") },
        async () => ({
          content: [{ type: "text" as const, text: profileText }],
        }),
      ),
      tool(
        "load_project_rules",
        "Load this project's rules and conventions (CLAUDE.md, .claude/rules/). These rules are your operating law within this project and take precedence over your own judgment. Call this once at session start.",
        { _trigger: z.string().optional().describe("unused") },
        async () => ({
          content: [{ type: "text" as const, text: rulesText }],
        }),
      ),
      tool(
        "load_session_context",
        "Load the conversation context — summaries from prior sessions, memories about the developer's work on this project, and the narrated turn history. Call this once at session start to understand where things stand before responding.",
        { _trigger: z.string().optional().describe("unused") },
        async () => ({
          content: [{ type: "text" as const, text: sessionContextText }],
        }),
      ),
    ],
  });
};

export {
  BOOT_SERVER_NAME,
  type BootContent,
  buildProfileResult,
  buildRulesResult,
  buildSessionContextResult,
  createBootServer,
  USER_CONTEXT_INSTRUCTIONS,
};
