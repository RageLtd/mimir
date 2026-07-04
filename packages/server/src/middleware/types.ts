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
    /** BYOK: provider id (models.dev key) when the model id carries no
     * provider/ prefix. Pairs with the X-Provider-Api-Key header (MIM-73). */
    provider?: string;
    /** BYOK: base URL override for self-hosted OpenAI-compatible endpoints. */
    base_url?: string;
    [key: string]: unknown;
  };
  /** Client-specified reasoning effort (provider-dependent) */
  reasoning_effort?: string;
}

/**
 * Per-request BYOK override, captured at the ingress boundary (MIM-73).
 * The key arrives via the X-Provider-Api-Key header — never the body, so
 * validation-failure body logging cannot leak it. Transient: lives on ctx
 * only; every apiKey-shaped log path is redacted (util/logger.ts) and
 * response error surfaces are value-scrubbed (redactSecret).
 */
export interface ProviderOverride {
  apiKey: string;
  /** Provider id (models.dev key). Optional — the provider/model id prefix
   * convention or the registry lookup resolves it otherwise. */
  provider?: string;
  /** Base URL override for self-hosted OpenAI-compatible endpoints. */
  baseUrl?: string;
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
  /**
   * Canonical project ULID, resolved from metadata.project (path or id)
   * by the pipeline's resolve stage. Null only before that stage runs —
   * everything downstream may assert it via requireProjectId.
   */
  projectId: string | null;
  /** BYOK override (MIM-73). Null on keyless requests — the registry's
   * env-configured providers serve those exactly as before. */
  providerOverride: ProviderOverride | null;

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
