/**
 * HTTP client for mimir-server.
 *
 * Sends OpenAI-compatible chat completion requests,
 * returns an async iterator of SSE events.
 * The caller (agent loop) accumulates tool calls and decides
 * whether to resubmit.
 */

import type { ModelInfo } from "@agentclientprotocol/sdk";
import { iterateSSE, type SSEEvent } from "./sse-parser";
import { errMessage } from "./util";
import { createChildLogger, log as rootLog } from "./utils/log";

const log = createChildLogger(rootLog, "server-client");

// ── Types ──

import type { OpenAIContentPart } from "./agent/content";

export type ChatMessage = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | OpenAIContentPart[] | null;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: "function";
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
  readonly tool_call_id?: string;
  readonly name?: string;
};

export type ToolDefinition = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
};

export type CompletionRequest = {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[];
  readonly stream?: boolean;
  readonly temperature?: number;
  readonly metadata?: Record<string, unknown>;
  readonly reasoning_effort?: string;
};

export type ServerClientConfig = {
  readonly baseUrl: string;
  readonly apiKey: string;
};

// ── Helpers ──

const authHeaders = (apiKey: string): Record<string, string> =>
  apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

const postJson = async (
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    throw new Error(`Server returned ${response.status}: ${text}`);
  }

  return response;
};

// ── Public API ──

/**
 * Stream a chat completion from mimir-server.
 *
 * Yields raw SSE events. The caller is responsible for accumulating
 * tool_call_delta events into resolved tool calls.
 */
export const streamCompletion = async function* (
  config: ServerClientConfig,
  request: CompletionRequest,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent, void, undefined> {
  const headers = authHeaders(config.apiKey);
  const response = await postJson(
    `${config.baseUrl}/v1/chat/completions`,
    {
      ...request,
      stream: true,
      // Ask mimir-server to emit the OpenAI-spec usage chunk after the
      // turn ends. Carries token counts and (mimir extension) the model's
      // context window so prompt-server.ts can emit a usage_update.
      stream_options: { include_usage: true },
    },
    headers,
    signal,
  );

  if (!response.body) {
    throw new Error("Server returned empty response body");
  }

  yield* iterateSSE(response.body);
};

/**
 * Fetch the server's tool manifest.
 * Returns an empty array if the endpoint is unavailable.
 */
export const getTools = async (
  config: ServerClientConfig,
  signal?: AbortSignal,
): Promise<ToolDefinition[]> => {
  const headers = authHeaders(config.apiKey);

  try {
    const response = await fetch(`${config.baseUrl}/v1/tools`, {
      method: "GET",
      headers,
      signal,
    });

    if (!response.ok) {
      return [];
    }

    return response.json() as Promise<ToolDefinition[]>;
  } catch (err) {
    log.debug(
      "tool manifest fetch failed:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
};

// ── Model list ──

const EMPTY_SERVER_MODELS = {
  models: [] as ModelInfo[],
  reasoningModels: new Set<string>(),
};

type ServerModelEntry = {
  id: string;
  object?: string;
  owned_by?: string;
  /** Human-readable model name from provider-data (e.g. "Kimi K2.5"). */
  display_name?: string;
  /** Human-readable provider name from provider-data (e.g. "OpenCode Go"). */
  provider_name?: string;
  /** Whether the model supports extended thinking / reasoning. */
  reasoning?: boolean;
};

/**
 * Titlecase fallback for `owned_by` when the server didn't include a
 * `provider_name`. Splits on dashes and underscores, capitalises each
 * part. Keeps unknown providers visually distinct from registered ones
 * without requiring a client-side provider catalogue.
 *
 * Exported for unit testing.
 */
export const titlecaseProviderId = (id: string) =>
  id
    .split(/[-_]/g)
    .map((part) =>
      part.length > 0 ? part.charAt(0).toUpperCase() + part.slice(1) : "",
    )
    .join(" ");

/**
 * Compose the `name` field shown in the editor's model selector.
 * `display_name (provider_name)` when both are present; falls back to
 * `display_name` (no parenthetical), or `id (provider)` when only the
 * provider is known, or just `id` for entries with no enrichment.
 *
 * Exported for unit testing.
 */
export const composeServerModelName = (m: ServerModelEntry) => {
  const display = m.display_name ?? m.id;
  if (!m.owned_by) return display;
  const provider = m.provider_name ?? titlecaseProviderId(m.owned_by);
  return `${display} (${provider})`;
};

/**
 * Fetch mimir-server's `/v1/models` and return entries as ACP ModelInfo
 * plus the set of model ids that advertise reasoning support. Returns an
 * empty list on failure so the model picker degrades gracefully rather
 * than the session failing to start.
 */
export const fetchServerModels = async (
  serverUrl: string,
  apiKey: string,
  signal?: AbortSignal,
) => {
  const url = `${serverUrl}/v1/models`;
  const headers = authHeaders(apiKey);
  const res = await fetch(url, { headers, signal }).catch(errMessage);
  if (typeof res === "string") {
    log.warn(`server model fetch failed: ${res} (${url})`);
    return EMPTY_SERVER_MODELS;
  }
  if (!res.ok) {
    log.warn(
      `server model fetch failed: ${res.status} ${res.statusText} (${url})`,
    );
    return EMPTY_SERVER_MODELS;
  }
  const body = await res.json().catch(errMessage);
  if (typeof body === "string") {
    log.warn(`server model fetch — invalid JSON: ${body} (${url})`);
    return EMPTY_SERVER_MODELS;
  }
  const data = (body as { data?: ServerModelEntry[] }).data ?? [];
  const reasoningModels = new Set<string>();
  const models = data.map((m) => {
    if (m.reasoning) reasoningModels.add(m.id);
    return {
      modelId: m.id,
      name: composeServerModelName(m),
      description: m.owned_by ? `Provider: ${m.owned_by}` : undefined,
    };
  });
  log.info(
    `fetched ${models.length} models from mimir-server (${reasoningModels.size} with reasoning)`,
  );
  return { models, reasoningModels };
};
