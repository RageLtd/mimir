/**
 * Pipeline types for the Mimir middleware architecture.
 *
 * Core principle: Data enters as a validated typed object, flows through
 * middleware as that same typed object (mutated in place), and exits through
 * AI SDK's built-in response helpers. No intermediate serialization.
 */

import type { LanguageModel, ModelMessage, ToolSet } from "ai";

/**
 * Validated input from the OpenAI-compatible request.
 * This is the ONE place we parse the incoming JSON.
 */
export interface ChatRequest {
  model: string;
  messages: ModelMessage[]; // AI SDK v6: replaces CoreMessage
  stream: boolean;
  tools?: OpenAIToolDef[]; // Raw OpenAI-format tools from client
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  metadata?: {
    session_id?: string;
    project?: string;
    [key: string]: unknown;
  };
  /** Client-specified reasoning effort (provider-dependent) */
  reasoning_effort?: string;
}

/**
 * OpenAI-format tool definition (what clients like Zed send).
 * We convert these ONCE at the tool classification stage.
 */
export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>; // JSON Schema object
  };
}

/**
 * The context object that flows through the middleware pipeline.
 * Each middleware reads and mutates this — no return value ceremony.
 */
export interface MimirContext {
  // -- Set at input boundary --
  request: ChatRequest;
  project: string; // from metadata.project or "default"

  // -- Set by MW1: system prompt --
  systemPrompt: string;

  // -- Set by MW2: goldfish --
  memories: string | null; // formatted memory text for context injection
  playbooks: string | null; // formatted playbook index + ambient bodies

  // -- Set by MW2.6: project rules (from ACP metadata) --
  projectRules: string | null;

  // -- Set by MW3: context assembly --
  conversationMessages: ModelMessage[]; // the actual messages to send to the model
  contextInjection: ModelMessage[]; // synthetic user+assistant pair (summaries + memories)
  compactionTriggered: boolean;

  // -- Set by MW4: tool classification --
  serverTools: ToolSet; // AI SDK v6: tools with execute(), run server-side
  clientTools: ToolSet; // AI SDK v6: tools WITHOUT execute(), returned to client
  allTools: ToolSet; // merged set for the model to see

  // -- Set by agent runner --
  resolvedModel: LanguageModel | null; // from provider registry
}
