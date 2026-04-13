/**
 * MCP Streamable HTTP server — POST /mcp (+ GET /mcp → 405)
 *
 * Exposes Goldfish (memory), Cartographer, and web_search to Claude Code
 * via the Model Context Protocol Streamable HTTP transport (2025-03-26).
 *
 * Transport: Streamable HTTP (MCP spec 2025-03-26)
 *   POST /mcp  — receives JSON-RPC 2.0 requests; responds with
 *                Content-Type: application/json directly (no SSE stream
 *                needed for stateless tool calls)
 *   GET  /mcp  — returns 405; no server-to-client notification stream
 *
 * Configure in mimir-mcp.json:
 *   { "mcpServers": { "mimir": { "type": "http", "url": "http://localhost:8080/mcp" } } }
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  executeFileInfo,
  executeQuery,
  executeSearch,
  FileInfoSchema,
  QuerySchema,
  SearchSchema,
} from "../agent-loop/server-tools/cartographer";
import {
  executeWebSearch,
  WebSearchSchema,
} from "../agent-loop/server-tools/external";
import {
  executeMemoryDelete,
  executeMemoryList,
  executeMemorySearch,
  executeMemoryStore,
  MemoryDeleteSchema,
  MemoryListSchema,
  MemorySearchSchema,
  MemoryStoreSchema,
} from "../agent-loop/server-tools/memory";
import { log } from "../util/logger";

export const mcp = new Hono();

// ── Tool registry ──────────────────────────────────────────────────────────

type McpToolDef = {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  run: (args: unknown) => Promise<unknown>;
};

const TOOLS: McpToolDef[] = [
  {
    name: "memory_search",
    description:
      "Search persistent memory for facts, preferences, or context from past conversations.",
    schema: MemorySearchSchema,
    run: (args) => executeMemorySearch(MemorySearchSchema.parse(args)),
  },
  {
    name: "memory_store",
    description:
      "Store a fact in persistent memory. Use when the user asks to remember something.",
    schema: MemoryStoreSchema,
    run: (args) => executeMemoryStore(MemoryStoreSchema.parse(args)),
  },
  {
    name: "memory_list",
    description: "List stored memories, most recent first.",
    schema: MemoryListSchema,
    run: (args) => executeMemoryList(MemoryListSchema.parse(args)),
  },
  {
    name: "memory_delete",
    description:
      "Delete a memory by ID. Confirm content with user before deleting.",
    schema: MemoryDeleteSchema,
    run: (args) => executeMemoryDelete(MemoryDeleteSchema.parse(args)),
  },
  {
    name: "cartographer_search",
    description:
      "Search indexed codebase for files by path or symbol name. Omit project to auto-detect.",
    schema: SearchSchema,
    run: (args) => executeSearch(SearchSchema.parse(args)),
  },
  {
    name: "cartographer_file_info",
    description:
      "Get file details: symbols, imports, and dependents. Omit project to auto-detect.",
    schema: FileInfoSchema,
    run: (args) => executeFileInfo(FileInfoSchema.parse(args)),
  },
  {
    name: "cartographer_query",
    description:
      "Walk import graph from entry points. Returns dependencies and dependents up to depth.",
    schema: QuerySchema,
    run: (args) => executeQuery(QuerySchema.parse(args)),
  },
  {
    name: "web_search",
    description:
      "Search the web for current information. Use for up-to-date data, news, or recent docs.",
    schema: WebSearchSchema,
    run: (args) => executeWebSearch(WebSearchSchema.parse(args)),
  },
];

// ── JSON-RPC types ─────────────────────────────────────────────────────────

type JsonRpcRequest = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id?: string | number | null;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string };
  id: string | number | null;
};

// ── JSON-RPC dispatch ──────────────────────────────────────────────────────

async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  // Notifications (no id) require no response
  if (req.id === undefined) return null;

  const id = req.id ?? null;

  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "mimir", version: "1.0.0" },
        },
        id,
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        result: {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: z.toJSONSchema(t.schema),
          })),
        },
        id,
      };

    case "tools/call": {
      const params = req.params as { name: string; arguments?: unknown };
      const t = TOOLS.find((tool) => tool.name === params.name);

      if (!t) {
        return {
          jsonrpc: "2.0",
          error: { code: -32601, message: `Tool not found: ${params.name}` },
          id,
        };
      }

      try {
        const result = await t.run(params.arguments ?? {});
        return {
          jsonrpc: "2.0",
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          },
          id,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error({ err, tool: params.name }, "mcp tool error");
        return {
          jsonrpc: "2.0",
          result: {
            content: [{ type: "text", text: `Error: ${errMsg}` }],
            isError: true,
          },
          id,
        };
      }
    }

    default:
      return {
        jsonrpc: "2.0",
        error: { code: -32601, message: `Method not found: ${req.method}` },
        id,
      };
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /mcp — Streamable HTTP transport entry point.
 *
 * Accepts a single JSON-RPC request or notification.
 * - Notifications (no id): 202 Accepted, no body.
 * - Requests: 200 with application/json response.
 */
mcp.post("/", async (c) => {
  const body = (await c.req.json()) as JsonRpcRequest;
  log.info({ method: body.method }, "mcp request");

  const response = await dispatch(body);

  if (response === null) {
    return new Response(null, { status: 202 });
  }

  return c.json(response);
});

/**
 * GET /mcp — No server-to-client notification stream offered.
 * 405 is explicitly allowed by the spec for servers that don't need it.
 */
mcp.get("/", (_c) => {
  return new Response(null, { status: 405 });
});
