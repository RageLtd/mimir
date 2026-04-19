/**
 * Client-MCP manager for the mimir-server backend path.
 *
 * The ACP spec says: "Agents SHOULD connect to all MCP servers specified
 * by the Client." Clients use this to expose tools (filesystem, database,
 * custom integrations) directly to the underlying language model.
 *
 * The CC backend handles this automatically — the Claude Agent SDK takes
 * `mcpServers` as an option and opens its own connections. The server
 * backend (mimir-server via OpenAI-compatible API) has no such plumbing,
 * so mimir-acp needs to do the equivalent itself:
 *
 *   1. Lazy-connect an MCP client per `clientMcpServers` entry on first use.
 *   2. Enumerate tools via `listTools()`, convert to ToolDefinition, and
 *      merge into the manifest we ship to mimir-server.
 *   3. Namespace tool names as `mcp__{serverName}__{toolName}` — the same
 *      convention the Claude Agent SDK applies on the CC backend, so
 *      models see the same tool identity regardless of which backend is
 *      serving the prompt.
 *   4. Dispatch tool calls whose namespaced name matches a known entry
 *      through that server's client; return stringified text content as
 *      a tool message.
 *   5. Close all connections on session dispose.
 *
 * One manager instance per session. Handlers own the lifecycle.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDefinition } from "../server-client";
import { errMessage } from "../util";
import { createChildLogger, log } from "../utils/log";

const logger = createChildLogger(log, "client-mcp");

const NAMESPACE_PREFIX = "mcp__";
const NAMESPACE_SEPARATOR = "__";

export type ClientMcpManager = {
  /**
   * Resolve tool definitions for all configured client MCP servers, opening
   * connections on first call. Subsequent calls return the cached list.
   * Tool names are namespaced as `mcp__{serverName}__{toolName}` to match
   * the Claude Agent SDK convention.
   */
  readonly getToolDefs: () => Promise<ToolDefinition[]>;
  /**
   * True iff `name` matches a namespaced tool advertised by any client MCP
   * server managed here. Used by the dispatcher to decide whether to route
   * a call through this manager.
   */
  readonly owns: (name: string) => boolean;
  /**
   * Execute a namespaced tool call. Returns a textual result suitable for
   * a `tool` message body. Throws if the tool is not owned or the call
   * fails and cannot be recovered into a useful error string.
   */
  readonly callTool: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<string>;
  /** Close all open MCP client connections. Safe to call repeatedly. */
  readonly close: () => Promise<void>;
};

type ServerEntry = {
  readonly name: string;
  readonly server: acp.McpServer;
  client: Client | null;
  /** Map of local (un-namespaced) tool name -> ToolDefinition. */
  tools: Map<string, ToolDefinition> | null;
};

const isStdioServer = (s: acp.McpServer): s is acp.McpServerStdio =>
  "command" in s;

const buildTransport = (server: acp.McpServer) => {
  if (isStdioServer(server)) {
    const env: Record<string, string> = {};
    for (const e of server.env ?? []) {
      env[e.name] = e.value;
    }
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });
  }
  const headers: Record<string, string> = {};
  for (const h of server.headers ?? []) {
    headers[h.name] = h.value;
  }
  const url = new URL(server.url);
  const initHeaders = Object.keys(headers).length > 0 ? headers : undefined;
  if (server.type === "sse") {
    return new SSEClientTransport(url, {
      requestInit: initHeaders ? { headers: initHeaders } : undefined,
    });
  }
  return new StreamableHTTPClientTransport(url, {
    requestInit: initHeaders ? { headers: initHeaders } : undefined,
  });
};

const nsName = (serverName: string, toolName: string) =>
  `${NAMESPACE_PREFIX}${serverName}${NAMESPACE_SEPARATOR}${toolName}`;

const splitNsName = (namespaced: string) => {
  if (!namespaced.startsWith(NAMESPACE_PREFIX)) return null;
  const rest = namespaced.slice(NAMESPACE_PREFIX.length);
  const idx = rest.indexOf(NAMESPACE_SEPARATOR);
  if (idx < 0) return null;
  return {
    serverName: rest.slice(0, idx),
    toolName: rest.slice(idx + NAMESPACE_SEPARATOR.length),
  };
};

const toToolDef = (
  serverName: string,
  tool: {
    name: string;
    description?: string | undefined;
    inputSchema: Record<string, unknown>;
  },
) => ({
  type: "function" as const,
  function: {
    name: nsName(serverName, tool.name),
    description:
      tool.description ??
      `Tool \`${tool.name}\` exposed by the client MCP server \`${serverName}\`.`,
    parameters: tool.inputSchema,
  },
});

const formatCallResult = (result: {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}) => {
  const parts: string[] = [];
  for (const c of result.content ?? []) {
    if (c.type === "text" && typeof c.text === "string") {
      parts.push(c.text);
    } else {
      parts.push(`[${c.type}]`);
    }
  }
  const body = parts.join("\n");
  if (result.isError) {
    return `Error from tool: ${body || "(no content)"}`;
  }
  return body || "(no content)";
};

/**
 * Build a ClientMcpManager for a session. Connection is lazy — nothing
 * is opened until `getToolDefs()` or `callTool()` is called.
 *
 * Connection failures on individual servers are logged and the offending
 * server is skipped; one bad server MUST NOT break the whole session.
 */
export const createClientMcpManager = (
  sessionId: string,
  servers: readonly acp.McpServer[] | undefined,
) => {
  const entries: ServerEntry[] = (servers ?? []).map((server) => ({
    name: server.name,
    server,
    client: null,
    tools: null,
  }));

  let initPromise: Promise<void> | null = null;

  const initOne = async (entry: ServerEntry) => {
    const client = new Client(
      { name: "mimir-acp", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = buildTransport(entry.server);
    const connected = await client
      .connect(transport)
      .then(() => true as const)
      .catch((err: unknown) => {
        logger.warn(
          `failed to connect client MCP server \`${entry.name}\` for session ${sessionId}: ${errMessage(err)}`,
        );
        return false as const;
      });
    if (!connected) {
      entry.client = null;
      entry.tools = new Map();
      return;
    }
    const listed = await client.listTools().catch((err: unknown) => {
      logger.warn(
        `listTools failed for client MCP server \`${entry.name}\`: ${errMessage(err)}`,
      );
      return null;
    });
    if (!listed) {
      entry.client = client;
      entry.tools = new Map();
      return;
    }
    const tools = new Map<string, ToolDefinition>();
    for (const t of listed.tools) {
      tools.set(
        t.name,
        toToolDef(entry.name, {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
        }),
      );
    }
    entry.client = client;
    entry.tools = tools;
    logger.info(
      `connected client MCP server \`${entry.name}\` for session ${sessionId} — ${tools.size} tools`,
    );
  };

  const ensureInit = async () => {
    if (entries.length === 0) return;
    if (initPromise) return initPromise;
    initPromise = Promise.all(entries.map(initOne)).then(() => {});
    return initPromise;
  };

  const getToolDefs = async () => {
    await ensureInit();
    const all: ToolDefinition[] = [];
    for (const entry of entries) {
      if (!entry.tools) continue;
      for (const def of entry.tools.values()) all.push(def);
    }
    return all;
  };

  const lookup = (namespaced: string) => {
    const parts = splitNsName(namespaced);
    if (!parts) return null;
    const entry = entries.find((e) => e.name === parts.serverName);
    if (!entry?.tools) return null;
    if (!entry.tools.has(parts.toolName)) return null;
    return { entry, toolName: parts.toolName };
  };

  const owns = (name: string) => lookup(name) !== null;

  const callTool = async (name: string, input: Record<string, unknown>) => {
    await ensureInit();
    const resolved = lookup(name);
    if (!resolved) {
      throw new Error(`Tool \`${name}\` is not a client MCP tool.`);
    }
    const { entry, toolName } = resolved;
    if (!entry.client) {
      return `Error: client MCP server \`${entry.name}\` is not connected.`;
    }
    const result = await entry.client
      .callTool({ name: toolName, arguments: input })
      .then(
        (r) =>
          ({
            ok: true as const,
            value: r as Parameters<typeof formatCallResult>[0],
          }) as const,
      )
      .catch((err: unknown) => ({
        ok: false as const,
        error: errMessage(err),
      }));
    if (!result.ok) {
      logger.warn(
        `client MCP call \`${entry.name}.${toolName}\` failed: ${result.error}`,
      );
      return `Error calling ${name}: ${result.error}`;
    }
    return formatCallResult(result.value);
  };

  const close = async () => {
    for (const entry of entries) {
      if (!entry.client) continue;
      await entry.client.close().catch((err: unknown) => {
        logger.debug(
          `close of client MCP server \`${entry.name}\` threw: ${errMessage(err)}`,
        );
      });
      entry.client = null;
      entry.tools = null;
    }
    initPromise = null;
  };

  return { getToolDefs, owns, callTool, close };
};
