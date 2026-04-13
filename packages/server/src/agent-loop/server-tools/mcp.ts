/**
 * MCP client management — connects to external MCP servers at boot
 * and exposes their tools as server-side tools.
 *
 * Currently connects to:
 *   - Context7 (documentation lookup) — https://mcp.context7.com/sse
 *   - Time MCP (time awareness) — stdio via bunx time-mcp
 */

import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { Tool } from "ai";
import { config } from "../../config";
import { log } from "../../util/logger";
import { attempt } from "../../util/result";

/** Active MCP clients (for cleanup on shutdown) */
const clients: MCPClient[] = [];

/** Cached tools from all MCP servers */
let mcpTools: Record<string, Tool> = {};

/**
 * Initialize MCP clients and fetch their tools.
 * Call once during server boot. Failures are non-fatal.
 */
export async function initMcpTools(): Promise<void> {
  const tools: Record<string, Tool> = {};

  // --- Context7 ---
  const [c7Err, c7Client] = await attempt(async () => {
    const headers: Record<string, string> = {};
    if (config.context7.apiKey) {
      headers.CONTEXT7_API_KEY = config.context7.apiKey;
    }

    const transport = new Experimental_StdioMCPTransport({
      command: "bunx",
      args: config.context7.apiKey
        ? ["@upstash/context7-mcp", "--api-key", config.context7.apiKey]
        : ["@upstash/context7-mcp"],
    });

    const client = await createMCPClient({ transport });

    const c7Tools = client.tools();
    const toolNames = Object.keys(c7Tools);
    log.info({ tools: toolNames }, "Context7 MCP connected");

    Object.assign(tools, c7Tools);
    return client;
  });

  if (c7Err) {
    log.warn(
      { err: c7Err.message },
      "Context7 MCP unavailable — continuing without docs lookup",
    );
  } else if (c7Client) {
    clients.push(c7Client);
  }

  // --- Time MCP ---
  const [timeErr, timeClient] = await attempt(async () => {
    const transport = new Experimental_StdioMCPTransport({
      command: "bunx",
      args: ["time-mcp"],
    });

    const client = await createMCPClient({ transport });
    const timeTools = await client.tools();
    const toolNames = Object.keys(timeTools);
    log.info({ tools: toolNames }, "Time MCP connected");

    Object.assign(tools, timeTools);
    return client;
  });

  if (timeErr) {
    log.warn(
      { err: timeErr.message },
      "Time MCP unavailable — continuing without time awareness",
    );
  } else if (timeClient) {
    clients.push(timeClient);
  }

  mcpTools = tools;
  log.info(
    { totalMcpTools: Object.keys(mcpTools).length },
    "MCP tools initialized",
  );
}

/** Get all tools from connected MCP servers */
export function getMcpTools(): Record<string, Tool> {
  return mcpTools;
}

/** Get all MCP tool names (for SERVER_TOOL_NAMES set) */
export function getMcpToolNames(): string[] {
  return Object.keys(mcpTools);
}

/** Close all MCP clients (for graceful shutdown) */
export async function closeMcpClients(): Promise<void> {
  for (const client of clients) {
    await attempt(() => client.close());
  }
  clients.length = 0;
  log.info("MCP clients closed");
}
