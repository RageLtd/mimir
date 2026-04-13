/**
 * REST client for mimir-server's context APIs.
 *
 * Used by the Claude Code backend to fetch the same context the server
 * backend assembles internally: system prompt (cached), goldfish memories,
 * recent summaries — and to push conversation turns + token usage back so
 * goldfish, compaction, and memory extraction continue to work.
 *
 * The server backend does NOT use this client; mimir-server handles
 * everything internally for that path.
 */

import type { ChatMessage } from "./server-client";

// ── Types ──

export type ContextClientConfig = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly systemPromptTtlMs: number;
};

export type Summary = {
  readonly content: string;
  readonly token_count?: number;
  readonly created_at: string;
};

type CachedPrompt = {
  content: string;
  version: string;
  fetchedAt: number;
};

// ── Module-local cache for the system prompt ──

let cachedPrompt: CachedPrompt | null = null;

/** For tests. */
export const _resetSystemPromptCache = (): void => {
  cachedPrompt = null;
};

// ── Helpers ──

const authHeaders = (apiKey: string): Record<string, string> =>
  apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

const requestJson = async <T>(
  url: string,
  init: RequestInit,
  apiKey: string,
): Promise<T> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...authHeaders(apiKey),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${url} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
};

// ── System prompt (cached with TTL) ──

export const getSystemPrompt = async (
  cfg: ContextClientConfig,
  signal?: AbortSignal,
): Promise<string> => {
  const now = Date.now();
  if (cachedPrompt && now - cachedPrompt.fetchedAt < cfg.systemPromptTtlMs) {
    return cachedPrompt.content;
  }

  const data = await requestJson<{ content: string; version: string }>(
    `${cfg.baseUrl}/v1/system-prompt`,
    { method: "GET", signal },
    cfg.apiKey,
  );

  cachedPrompt = {
    content: data.content,
    version: data.version,
    fetchedAt: now,
  };
  return data.content;
};

// ── Memories ──

export const fetchMemories = async (
  cfg: ContextClientConfig,
  query: string,
  project?: string,
  signal?: AbortSignal,
): Promise<string | null> => {
  const data = await requestJson<{ memories: string | null }>(
    `${cfg.baseUrl}/v1/context/memories`,
    {
      method: "POST",
      body: JSON.stringify({ query, project }),
      signal,
    },
    cfg.apiKey,
  );
  return data.memories;
};

// ── Summaries ──

export const fetchSummaries = async (
  cfg: ContextClientConfig,
  count: number,
  signal?: AbortSignal,
): Promise<Summary[]> => {
  const data = await requestJson<{ summaries: Summary[] }>(
    `${cfg.baseUrl}/v1/context/summaries?count=${count}`,
    { method: "GET", signal },
    cfg.apiKey,
  );
  return data.summaries ?? [];
};

// ── Conversation persistence ──

export const persistTurn = async (
  cfg: ContextClientConfig,
  messages: readonly ChatMessage[],
  project: string,
  opts?: { totalCostUsd?: number },
  signal?: AbortSignal,
): Promise<{ appended: number; ids: (string | null)[] }> => {
  return requestJson<{ appended: number; ids: (string | null)[] }>(
    `${cfg.baseUrl}/v1/messages/persist`,
    {
      method: "POST",
      body: JSON.stringify({
        messages,
        project,
        totalCostUsd: opts?.totalCostUsd,
      }),
      signal,
    },
    cfg.apiKey,
  );
};

// ── Context assembly (CC backend) ──

export type AssembledMessage = {
  readonly role: "user" | "assistant";
  readonly content: string;
};

export type AssembledContext = {
  readonly systemPrompt: string;
  readonly messages: readonly AssembledMessage[];
};

export const assembleContext = (
  cfg: ContextClientConfig,
  query: string,
  project?: string,
  signal?: AbortSignal,
): Promise<AssembledContext> =>
  requestJson<AssembledContext>(
    `${cfg.baseUrl}/v1/context/assemble`,
    {
      method: "POST",
      body: JSON.stringify({ query, project }),
      signal,
    },
    cfg.apiKey,
  );

// ── Token tracking ──

export const reportTokenUsage = async (
  cfg: ContextClientConfig,
  promptTokens: number,
  project: string,
  modelId?: string,
  signal?: AbortSignal,
): Promise<{ needsCompaction: boolean }> => {
  return requestJson<{ needsCompaction: boolean }>(
    `${cfg.baseUrl}/v1/context/token-report`,
    {
      method: "POST",
      body: JSON.stringify({ promptTokens, project, modelId }),
      signal,
    },
    cfg.apiKey,
  );
};
