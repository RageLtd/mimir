/**
 * MCP server reachability probe.
 *
 * Opens a temporary MCP client connection to a server descriptor and
 * returns whether it's reachable plus the count of tools it advertises.
 * The tool count is the honest signal for "is this authenticated?" —
 * an unauthenticated Notion returns just `authenticate` and
 * `complete_authentication` (2 tools), while an authenticated one
 * returns its full toolset (~50+). The user reads the count and infers
 * state, no heuristics in the agent.
 *
 * Used by `/mcp list` to show real status. Stdio servers aren't probed
 * here — spawning the binary just to count tools is heavier than the
 * value warrants. They're listed without status.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { errMessage } from "@mimir/plugin-core/util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createChildLogger, log } from "../utils/log";

const logger = createChildLogger(log, "mcp-probe");

const DEFAULT_TIMEOUT_MS = 5000;

export type ProbeResult =
  | { readonly ok: true; readonly toolCount: number }
  | {
      readonly ok: false;
      readonly reason: "unauthorized" | "error";
      readonly message: string;
    };

const headersFromAcp = (headers: readonly acp.HttpHeader[] | undefined) => {
  const record: Record<string, string> = {};
  for (const h of headers ?? []) record[h.name] = h.value;
  return record;
};

/**
 * Probe a single HTTP MCP server. Returns the reachable+toolCount on
 * success, or a reason+message on failure. Always closes the transient
 * connection it opens.
 */
export const probeHttpServer = async (
  server: acp.McpServer,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
) => {
  if (!("url" in server)) {
    return {
      ok: false,
      reason: "error",
      message: "stdio servers are not probed",
    } satisfies ProbeResult;
  }
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: headersFromAcp(server.headers) },
  });
  const client = new Client({ name: "mimir-acp-probe", version: "1.0.0" });

  // Race the connect against a timeout so a hung server doesn't stall
  // `/mcp list`. Bun's AbortSignal.timeout would be cleaner but the SDK
  // doesn't expose that hook.
  const connectPromise = client.connect(transport).then(
    () => ({ ok: true as const }),
    (err: unknown) => ({ ok: false as const, error: err }),
  );
  const timeoutPromise = new Promise<{ ok: false; error: Error }>((resolve) =>
    setTimeout(
      () =>
        resolve({
          ok: false,
          error: new Error(`probe timed out after ${timeoutMs}ms`),
        }),
      timeoutMs,
    ),
  );

  const result = await Promise.race([connectPromise, timeoutPromise]);

  if (!result.ok) {
    await client.close().catch(() => {});
    const isUnauthorized =
      result.error instanceof Error &&
      result.error.name === "UnauthorizedError";
    const message = errMessage(result.error);
    logger.debug("%s probe failed: %s", server.name, message);
    return {
      ok: false,
      reason: isUnauthorized ? "unauthorized" : "error",
      message,
    } satisfies ProbeResult;
  }

  // Connected — list tools to get the count.
  const tools = await client.listTools().then(
    (r) => ({ ok: true as const, count: r.tools.length }),
    (err: unknown) => ({ ok: false as const, error: err }),
  );
  await client.close().catch(() => {});

  if (!tools.ok) {
    const message = errMessage(tools.error);
    logger.debug("%s tools/list failed: %s", server.name, message);
    return {
      ok: false,
      reason: "error",
      message,
    } satisfies ProbeResult;
  }

  return { ok: true, toolCount: tools.count } satisfies ProbeResult;
};
