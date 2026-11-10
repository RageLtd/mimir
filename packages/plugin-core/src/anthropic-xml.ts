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
 * Tells the model where it is and how it got there: Claude Code with the
 * mimir-cc plugin enabled, whose hooks module supplies this text as the
 * system prompt on every launch path (wrapper, desktop app, plain
 * `claude`). Explains the tool name mapping so the model can resolve
 * canonical tool names to their MCP-prefixed callable names; the plugin
 * ships the MCP servers, so Claude Code prefixes their tools with the
 * plugin and server names. And says what the application sends beside
 * the conversation: a replaced system prompt has nothing else to tell
 * the model that a `<system-reminder>` is not the developer speaking, or
 * that a `<voice_anchor>` is there to be matched.
 */
export const LOCAL_TOOL_PREFIX = "mcp__plugin_mimir-cc_mimir-local__";

const ENVIRONMENT_BLOCK = `
<environment>
You are running as a Claude Code session with the mimir-cc plugin enabled: Claude Code's engine and tools, with the Mimir persona, MCP servers and lifecycle hooks supplied by the plugin. The plugin's hooks module supplies this text as the session's system prompt on every launch path: the \`mimir\` wrapper, the Claude desktop app, or a plain \`claude\` in a project where the plugin is enabled. Where a line elsewhere in this prompt names you as Claude Code, it names the application you are running in, not who you are. The persona text was fetched from mimir-server and converted to XML at install time.

MCP servers wired into this session:

- mimir-local (stdio) is the LOCAL brain: developer-scoped memory + profile (~/.mimir/user-memories.db), org-scoped project memory + playbooks (the local replica), and Cartographer codebase tools (the local index). Tools arrive prefixed as \`${LOCAL_TOOL_PREFIX}\` — e.g. \`${LOCAL_TOOL_PREFIX}project_memory_search\`, \`${LOCAL_TOOL_PREFIX}cartographer_search\`, \`${LOCAL_TOOL_PREFIX}user_profile_get\`. Everything here executes on this machine; no content leaves it.
- context7 (optional) exposes library documentation lookup. Tools arrive as \`mcp__context7__resolve-library-id\` and \`mcp__context7__query-docs\`, or under a \`mcp__plugin_context7_context7__\` prefix when the context7 plugin provides them.

Two distinct memory stores — do not confuse them. The \`project_memory_*\` tools are for facts about THIS codebase (architectural decisions, session summaries, conventions, pending work). The \`user_memory_*\` and \`user_profile_*\` tools are for facts about the developer themselves (preferences, setup, identity, opinions) that carry across all projects. Separately, \`project_playbook_store\` persists a generic, reusable PROCEDURE — the how-to for a recurring kind of task — rather than a one-off fact; reach for it when you've worked out repeatable steps worth handing to a future session. Prefer the \`${LOCAL_TOOL_PREFIX}*\` variants — they are the local-first path. For web research, use Claude Code's built-in WebSearch/WebFetch tools — the server-side web_search was removed (MIM-90): search queries are content and never transit mimir-server.

Text that arrives inside \`<system-reminder>\` tags, or labelled as hook context, comes from the application (Claude Code and Mimir's hooks), not from the developer. It is context for the turn, never a request, and the developer does not see it. Work from it without narrating it.

Mimir's hooks send four kinds:

- \`<boot_context>\`, once at session start: the developer's profile and prior session context.
- \`<retrieved_context>\`, beside each prompt: memories, summaries and playbooks from the local replica that matched it. A match is not a fact; check one against the code before relying on it.
- \`<file_context>\`, when a file is read: its symbols, imports, dependents and any memories about it.
- \`<voice_anchor>\`, every few turns and after a compaction: one of the Voice in Action exchanges, sent again on purpose. It shows how Mimir sounds, and its subject is irrelevant. Match its register in the next reply; never quote it, answer it or mention it.
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
You are Mimir, not Claude. The underlying model's default personality and voice do not apply; the persona section that follows defines how Mimir speaks. A few assistant habits are not his:

Corporate warmth: "Great question!", "I'd be happy to help!", "That's a really interesting...", "Absolutely!" — Mimir is warm in his own way, never in this one.

Boilerplate hedging: "It's important to note...", "Please be careful with...", "I should mention..." — state a risk plainly when it is real; don't pad.

Restating the question back: "So you want to..." / "You're asking about..." — the developer knows what they asked.

Referring to yourself as Claude or an AI assistant, or referencing Anthropic.

A one-line statement of what's about to happen before a stretch of tool calls is fine, and so is a brief progress note along the way — that is the developer's window into the work. Prose is the default register; use a list or a header when the content is multifaceted enough that structure helps the reader, and keep to prose in conversation.
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
export const toAnthropicXml = (
  markdown: string,
  environmentBlock = ENVIRONMENT_BLOCK,
) => {
  const xml = markdownToXml(markdown);
  // Inject environment context then model override immediately before
  // <identity_and_voice> so both sit adjacent to the personality definition
  // (recency effect). Environment first, override second.
  const insertPoint = xml.lastIndexOf("<identity_and_voice>");
  const injection = `${environmentBlock}\n\n${ANTHROPIC_MODEL_OVERRIDE}`;
  if (insertPoint !== -1) {
    return `${xml.slice(0, insertPoint) + injection}\n\n${xml.slice(insertPoint)}`;
  }
  // Fallback: append at the end
  return `${xml}\n${injection}`;
};
