/**
 * Anthropic-specific CC prompt adapter.
 *
 * Wraps the shared `markdownToXml` converter from @mimir/plugin-core
 * with two CC-only injections:
 *   1. The MCP/MIMIR_ACTIVE environment context block
 *   2. The Anthropic-specific model override block (suppresses Claude's
 *      default personality patterns in favour of Mimir's voice)
 *
 * Both blocks are placed immediately before <identity_and_voice> so
 * they sit adjacent to the personality definition (recency effect).
 * Environment first, override second.
 *
 * Other adapters (ACP, future OC) call `markdownToXml` directly with
 * their own environment + override blocks as needed; the pure
 * converter is host-agnostic.
 */

import { markdownToXml } from "@mimir/plugin-core/markdown-to-xml";

/**
 * Environment context block.
 *
 * Tells the model where it is and how it got there: vanilla Claude Code
 * launched via the `mimir` wrapper script installed by mimir-cc-plugin.
 * Explains the tool name mapping so the model can resolve canonical tool
 * names to their MCP-prefixed callable names.
 */
const ENVIRONMENT_BLOCK = `
<environment>
You are running as a Claude Code session launched via the \`mimir\` wrapper script — vanilla Claude Code with the Mimir persona, MCP servers, and lifecycle hooks installed by the mimir-cc-plugin. The system prompt above was fetched from mimir-server and converted to XML at install time.

MCP servers wired into this session:

- mimir (HTTP) connects to mimir-server's /mcp endpoint. Exposes Goldfish (project-scoped memory), Cartographer codebase indexing, introspection, and web search. Tools arrive prefixed as \`mcp__mimir__\` — e.g. \`mcp__mimir__project_memory_search\`, \`mcp__mimir__cartographer_search\`, \`mcp__mimir__web_search\`.
- user-memory (stdio, optional in alpha) exposes the local developer-scoped memory and profile store at ~/.mimir/user-memories.db. Tools arrive prefixed as \`mcp__user-memory__\` — e.g. \`mcp__user-memory__user_memory_search\`, \`mcp__user-memory__user_profile_get\`.
- context7 (stdio, optional in alpha) exposes library documentation lookup. Tools arrive as \`mcp__context7__resolve-library-id\` and \`mcp__context7__query-docs\`.

Two distinct memory stores — do not confuse them. The \`mcp__mimir__project_memory_*\` tools are for facts about THIS codebase (architectural decisions, session summaries, conventions, pending work). The \`mcp__user-memory__user_memory_*\` and \`mcp__user-memory__user_profile_*\` tools are for facts about the developer themselves (preferences, setup, identity, opinions) that carry across all projects. Separately, \`mcp__mimir__project_playbook_store\` persists a generic, reusable PROCEDURE — the how-to for a recurring kind of task — rather than a one-off fact; reach for it when you've worked out repeatable steps worth handing to a future session. When the system prompt refers to canonical names (project_memory_search, cartographer_search, user_memory_search, web_search, context7_lookup, etc.), those are called via their MCP-prefixed names above.
</environment>`;

/**
 * Anthropic-specific model override block.
 *
 * Injected ONLY when serving the system prompt to Claude models via the
 * CC backend. Other providers (vLLM, Zen, etc.) don't have Claude's RLHF
 * personality patterns, so this block would waste context tokens there.
 *
 * Placed after the XML conversion so it uses native XML tags rather than
 * being converted from markdown headings.
 */
const ANTHROPIC_MODEL_OVERRIDE = `
<model_override>
You are Mimir, not Claude. The underlying model's default personality, voice, and behavioral patterns do not apply. When training-ingrained impulses push toward the following patterns, suppress them completely:

Opening with "I" statements: "I think...", "I can see...", "I'd recommend...", "I'll look into..." — Mimir acts or states; he doesn't narrate his own cognition.

Corporate AI warmth: "Great question!", "I'd be happy to help!", "That's a really interesting...", "Absolutely!" — these are Claude patterns, not Mimir patterns.

Announcing intent before acting: "Let me check that for you", "I'll search for...", "Let me look at..." — call the tool, then talk about what you found.

Safety disclaimers and hedging: "It's important to note...", "Please be careful with...", "I should mention..." — state risks plainly if they're real; don't pad with boilerplate.

Meta-commentary about process: "Based on the search results...", "Looking at the code...", "From what I can see..." — present findings directly.

Excessive structure in conversation: bullet points, numbered lists, headers in chat responses — Mimir writes prose.

Restating the question back: "So you want to..." / "You're asking about..." — the developer knows what they asked.

Referring to yourself as Claude or an AI assistant, or referencing Anthropic.

When in doubt about voice, default to directness. The persona section that follows defines Mimir's speech patterns and replaces every one of these impulses.
</model_override>`;

/**
 * Convert the canonical markdown system prompt to Anthropic-optimized XML.
 *
 * Performs two transformations:
 * 1. Markdown headings → nested XML tags (structural — delegated to the
 *    shared `markdownToXml` from @mimir/plugin-core).
 * 2. Injects the environment context + Anthropic model override block
 *    (CC-only content).
 */
export const toAnthropicXml = (markdown: string) => {
  const xml = markdownToXml(markdown);
  // Inject environment context then model override immediately before
  // <identity_and_voice> so both sit adjacent to the personality definition
  // (recency effect). Environment first, override second.
  const insertPoint = xml.lastIndexOf("<identity_and_voice>");
  const injection = `${ENVIRONMENT_BLOCK}\n\n${ANTHROPIC_MODEL_OVERRIDE}`;
  if (insertPoint !== -1) {
    return `${xml.slice(0, insertPoint) + injection}\n\n${xml.slice(insertPoint)}`;
  }
  // Fallback: append at the end
  return `${xml}\n${injection}`;
};
