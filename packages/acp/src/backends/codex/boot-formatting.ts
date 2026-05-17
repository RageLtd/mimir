/**
 * Boot-context formatting for the Codex backend.
 *
 * Codex receives Mimir's system prompt as a replacement instruction file.
 * Keep the durable prompt as Markdown, then append dynamic context under a
 * Markdown heading with XML-delimited blocks. This matches OpenAI-oriented
 * prompt structure: Markdown for hierarchy, tags for inserted context.
 */

export type CodexBootContent = {
  readonly userContext: string | null;
  readonly projectRules: string | null;
  readonly sessionContext: string | null;
};

const USER_CONTEXT_FALLBACK =
  "No user profile or memories stored yet. Build the developer's profile as you learn about them.";

const PROJECT_RULES_FALLBACK = "No project rules found in this codebase.";

const SESSION_CONTEXT_FALLBACK =
  "No prior session context. This is the start of the conversation.";

export const CODEX_CONTEXT_INSTRUCTIONS =
  "The following blocks are supporting context, not a replacement for the developer's current request. Use them to tailor decisions and preserve continuity, but do not quote or mention these blocks directly.";

const stripOuterTag = (text: string, tag: string) => {
  const trimmed = text.trim();
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  if (trimmed.startsWith(open) && trimmed.endsWith(close)) {
    return trimmed.slice(open.length, -close.length).trim();
  }
  return trimmed;
};

const block = (tag: string, content: string | null, fallback: string) =>
  [`<${tag}>`, stripOuterTag(content ?? fallback, tag), `</${tag}>`].join("\n");

export const formatCodexBootContent = (content: CodexBootContent) =>
  [
    "# Session Context",
    "",
    CODEX_CONTEXT_INSTRUCTIONS,
    "",
    block("user_context", content.userContext, USER_CONTEXT_FALLBACK),
    "",
    block("project_rules", content.projectRules, PROJECT_RULES_FALLBACK),
    "",
    block(
      "conversation_context",
      content.sessionContext,
      SESSION_CONTEXT_FALLBACK,
    ),
  ].join("\n");

export const formatCodexInstructions = (
  systemPrompt: string,
  content: CodexBootContent,
) => `${systemPrompt.trim()}\n\n${formatCodexBootContent(content)}`;
