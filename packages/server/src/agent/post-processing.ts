import type { ToolSet } from "ai";

/**
 * Tool call classification — the one piece of turn post-processing that
 * survived MIM-86. Persistence, compaction, and memory extraction all
 * relocated client-side (the plaintext lives there); the server retains
 * zero memory intelligence.
 */

/**
 * Split a set of tool calls into server-side (executed internally) and
 * client-side (emitted to the caller). Single source of truth for the
 * classification.
 *
 * Classifies against the actual server ToolSet on the context — a call is
 * server-side iff a tool by that name exists in `serverTools`. Since
 * getServerTools() merges connected MCP servers' tools by construction,
 * late-connecting MCP servers classify correctly with no name-set to
 * refresh.
 *
 * Accepts Record<string, unknown> to carry providerMetadata (Google
 * thoughtSignature) and any future SDK fields without enumerating.
 */
export function classifyToolCalls(
  toolCalls: Array<Record<string, unknown>>,
  serverTools: ToolSet,
) {
  return {
    serverCalls: toolCalls.filter((tc) => String(tc.toolName) in serverTools),
    clientCalls: toolCalls.filter(
      (tc) => !(String(tc.toolName) in serverTools),
    ),
  };
}
