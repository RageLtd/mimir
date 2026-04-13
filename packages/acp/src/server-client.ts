/**
 * HTTP client for mimir-server.
 *
 * Sends OpenAI-compatible chat completion requests,
 * returns an async iterator of SSE events.
 * The caller (agent loop) accumulates tool calls and decides
 * whether to resubmit.
 */

import { iterateSSE, type SSEEvent } from "./sse-parser";

// ── Types ──

export type ChatMessage = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
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
    { ...request, stream: true },
    headers,
    signal,
  );

  if (!response.body) {
    throw new Error("Server returned empty response body");
  }

  yield* iterateSSE(response.body);
};

/**
 * Non-streaming completion. Used for tool resubmission when we
 * don't need to stream intermediate tokens.
 */
export const complete = async (
  config: ServerClientConfig,
  request: CompletionRequest,
  signal?: AbortSignal,
): Promise<unknown> => {
  const headers = authHeaders(config.apiKey);
  const response = await postJson(
    `${config.baseUrl}/v1/chat/completions`,
    { ...request, stream: false },
    headers,
    signal,
  );

  return response.json();
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
  } catch {
    return [];
  }
};
