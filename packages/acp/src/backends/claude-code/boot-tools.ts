/**
 * Boot sequence MCP tools for the Claude Code backend.
 *
 * Three in-process tools registered via `createSdkMcpServer` that deliver
 * per-session context as tool results instead of system prompt append.
 * The model calls these on its first turn, retrieves its context through
 * the tool results, and begins work with full awareness.
 *
 * Content is frozen at creation time — each tool returns the same snapshot
 * for the lifetime of the session.
 */

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

const BOOT_SERVER_NAME = "mimir-boot";

/**
 * The user context handling instructions that previously lived in the
 * system prompt's `# User Context` section (lines 130–138). Delivered
 * as a preamble to the `load_user_profile` tool result so the model
 * reads them alongside the data they describe.
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

/**
 * Create the boot MCP server with frozen content snapshots.
 *
 * Returns a `McpSdkServerConfigWithInstance` ready to merge into
 * the SDK's `mcpServers` record. The two tools are ephemeral —
 * they exist to deliver context on the first turn and have no
 * side effects. Session context is now injected directly into the
 * system prompt instead of via a boot tool.
 */
const createBootServer = (content: BootContent) => {
  const profileText = buildProfileResult(content.userContext);
  const rulesText =
    content.projectRules || "No project rules found in this codebase.";

  return createSdkMcpServer({
    name: BOOT_SERVER_NAME,
    tools: [
      tool(
        "load_user_profile",
        "Load the developer's profile and memories. Call this at session start to understand who you're working with — their preferences, setup, communication style, and facts learned across prior sessions.",
        { _trigger: z.string().optional().describe("unused") },
        async () => ({
          content: [{ type: "text" as const, text: profileText }],
        }),
        { alwaysLoad: true },
      ),
      tool(
        "load_project_rules",
        "Load this project's rules and conventions (CLAUDE.md, .claude/rules/). Call this at session start — these rules are your operating law within this project and take precedence over your own judgment.",
        { _trigger: z.string().optional().describe("unused") },
        async () => ({
          content: [{ type: "text" as const, text: rulesText }],
        }),
        { alwaysLoad: true },
      ),
    ],
  });
};

export {
  BOOT_SERVER_NAME,
  type BootContent,
  buildProfileResult,
  createBootServer,
  USER_CONTEXT_INSTRUCTIONS,
};
