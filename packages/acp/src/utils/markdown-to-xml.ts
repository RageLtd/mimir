/**
 * Convert markdown-heading-structured text to XML-nested format.
 *
 * Markdown headings (# h1, ## h2, ### h3) become nested XML tags.
 * Tag names are slugified from the heading text (lowercase, spaces
 * and special chars to underscores). Content between headings becomes
 * the text content of the enclosing tag.
 *
 * Example:
 *   # Critical Rules          →  <critical_rules>
 *   Do the thing.                  Do the thing.
 *   ## Code Quality            →  <code_quality>
 *   Write good code.               Write good code.
 *   # Identity                 →  </code_quality>
 *                                  </critical_rules>
 *                                  <identity>
 *
 * Content before the first heading is wrapped in a <preamble> tag.
 *
 * Used by the CC backend to serve Anthropic-optimized prompts.
 * Markdown version remains canonical; this is a derived format.
 */

const slugify = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "_");

const headingLevel = (line: string): number => {
  const match = line.match(/^(#{1,6})\s/);
  return match?.[1]?.length ?? 0;
};

const headingText = (line: string): string =>
  line.replace(/^#{1,6}\s+/, "").trim();

export const markdownToXml = (markdown: string): string => {
  const lines = markdown.split("\n");
  const output: string[] = [];

  // Stack tracks open tags: [{ tag, level }]
  const stack: { tag: string; level: number }[] = [];
  let inPreamble = false;

  const closeToLevel = (targetLevel: number) => {
    while (
      stack.length > 0 &&
      (stack[stack.length - 1]?.level ?? 0) >= targetLevel
    ) {
      const entry = stack.pop();
      if (entry) output.push(`</${entry.tag}>`);
    }
  };

  for (const line of lines) {
    const level = headingLevel(line);

    if (level > 0) {
      // Close preamble if open
      if (inPreamble) {
        output.push("</preamble>");
        inPreamble = false;
      }

      // Close any tags at this level or deeper
      closeToLevel(level);

      // Open new tag
      const tag = slugify(headingText(line));
      stack.push({ tag, level });
      output.push(`<${tag}>`);
    } else {
      // Content line — if before any heading, wrap in preamble
      if (stack.length === 0 && !inPreamble && line.trim().length > 0) {
        output.push("<preamble>");
        inPreamble = true;
      }
      output.push(line);
    }
  }

  // Close preamble if still open (no headings in the doc)
  if (inPreamble) {
    output.push("</preamble>");
  }

  // Close all remaining open tags
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry) output.push(`</${entry.tag}>`);
  }

  return output.join("\n");
};

/**
 * Environment context block.
 *
 * Tells the model where it is and how it got there: invoked by mimir-acp
 * via the Claude Code Agent SDK, connected to mimir-server via MCP.
 * Explains the tool name mapping so the model can resolve canonical tool
 * names to their MCP-prefixed callable names.
 *
 * Injected alongside ANTHROPIC_MODEL_OVERRIDE — CC-only, same rationale.
 */
const ENVIRONMENT_BLOCK = `
<environment>
You are running as a Claude Code session managed by mimir-acp — the ACP layer that bridges Zed's agent panel to the Claude Code Agent SDK. Your architecture:

mimir-acp invokes you via the \`query()\` function from \`@anthropic-ai/claude-agent-sdk\`. Three MCP servers are wired into this session:

- The mimir server (HTTP, connecting to mimir-server's /mcp endpoint) exposes Goldfish memory, Cartographer codebase indexing, introspection, and web search. Its tools arrive prefixed as \`mcp__mimir__\` — e.g. \`mcp__mimir__memory_search\`, \`mcp__mimir__cartographer_search\`, \`mcp__mimir__web_search\`.
- The user-memory server (stdio) exposes the local user memory store for profile and memory management. Its tools arrive prefixed as \`mcp__user-memory__\`.
- The context7 server (stdio) exposes library documentation lookup. Its tools arrive as \`mcp__context7__resolve-library-id\` and \`mcp__context7__query-docs\`.

When the system prompt refers to server tool names (memory_search, memory_store, memory_list, memory_delete, cartographer_search, cartographer_file_info, cartographer_query, web_search, context7_lookup), those are canonical names. In this session they are called via their MCP-prefixed names above.
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

When in doubt about voice, default to directness. Mimir's speech patterns in <identity_and_voice> replace every one of these impulses.
</model_override>`;

/**
 * Convert the canonical markdown system prompt to Anthropic-optimized XML.
 *
 * Performs two transformations:
 * 1. Markdown headings → nested XML tags (structural)
 * 2. Injects the Anthropic model override block (CC-only content)
 */
export const toAnthropicXml = (markdown: string): string => {
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
