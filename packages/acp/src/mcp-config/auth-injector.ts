/**
 * OAuth bearer-token injector for HTTP MCP servers.
 *
 * Sits between `.mcp.json`/Zed-supplied server descriptors and the
 * Claude Agent SDK's `mcpServers` config builder. Walks the merged
 * server list, finds HTTP servers that have a persisted access token
 * from a prior OAuth flow, and rewrites their `headers` to include
 * `Authorization: Bearer <token>`. Servers without persisted tokens
 * pass through unchanged — they can either be authenticated on demand
 * via `/mcp auth <name>` or left as bootstrap-only (model sees just
 * the auth tools).
 *
 * Static `Authorization` headers (e.g. an Internal Integration token
 * declared in `.mcp.json`) win — we never overwrite an existing
 * `Authorization` entry.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { createChildLogger, log } from "../utils/log";
import { runOAuthFlow } from "./oauth-flow";
import { readStoredAccessToken } from "./oauth-storage";

const logger = createChildLogger(log, "auth-injector");

const AUTHORIZATION = "Authorization";

const isHttpServer = (server: acp.McpServer) =>
  "url" in server && (server.type === "http" || server.type === "sse");

const hasStaticAuthorization = (headers: readonly acp.HttpHeader[]) =>
  headers.some((h) => h.name.toLowerCase() === "authorization");

const withBearer = (server: acp.McpServer, token: string) => {
  if (!isHttpServer(server)) return server;
  const headers = server.headers ?? [];
  if (hasStaticAuthorization(headers)) return server;
  // Build a new server descriptor with the bearer header appended.
  // The original `headers` array is readonly — we never mutate it.
  const newHeaders = [
    ...headers,
    { name: AUTHORIZATION, value: `Bearer ${token}` },
  ];
  if (server.type === "sse") {
    return { ...server, headers: newHeaders };
  }
  return { ...server, headers: newHeaders };
};

/**
 * Walk the server list, attaching persisted Bearer tokens to HTTP servers
 * that have them. Returns a new array — the input list is left untouched.
 */
export const injectStoredTokens = async (servers: readonly acp.McpServer[]) => {
  const result: acp.McpServer[] = [];
  for (const server of servers) {
    if (!isHttpServer(server)) {
      result.push(server);
      continue;
    }
    if (hasStaticAuthorization(server.headers ?? [])) {
      // User-provided auth wins — never overwrite.
      result.push(server);
      continue;
    }
    const token = await readStoredAccessToken(server.name);
    if (token) {
      logger.info(
        "%s: attaching persisted Bearer token from prior OAuth flow",
        server.name,
      );
      result.push(withBearer(server, token));
    } else {
      result.push(server);
    }
  }
  return result;
};

/**
 * Run an OAuth flow for a single named server in the list. Returns the
 * updated list with the bearer header injected on success, or the
 * original list on failure (caller logs the error).
 */
export const authenticateServer = async (
  servers: readonly acp.McpServer[],
  name: string,
) => {
  const target = servers.find((s) => s.name === name);
  if (!target) {
    return { ok: false as const, error: `unknown server: ${name}`, servers };
  }
  if (!isHttpServer(target)) {
    return {
      ok: false as const,
      error: `server ${name} is stdio — OAuth doesn't apply`,
      servers,
    };
  }
  const result = await runOAuthFlow({
    serverName: name,
    serverUrl: target.url,
  });
  if (!result.ok) {
    return { ok: false as const, error: result.error, servers };
  }
  // Hoist the token out of the discriminated union — TS doesn't preserve
  // narrowing through the .map closure.
  const { accessToken } = result;
  const updated = servers.map((s) =>
    s.name === name ? withBearer(s, accessToken) : s,
  );
  return { ok: true as const, servers: updated };
};
