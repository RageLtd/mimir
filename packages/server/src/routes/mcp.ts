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

import { asSchema } from "ai";
import { Hono } from "hono";
import { getMcpPublicTools } from "../agent-loop/server-tools";
import { log } from "../util/logger";

export const mcp = new Hono();

// ── Tool registry ──────────────────────────────────────────────────────────
// Derived automatically from getMcpPublicTools() — add new tools there, not here.

const TOOLS = getMcpPublicTools();

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
          tools: Object.entries(TOOLS).map(([name, t]) => ({
            name,
            description: t.description ?? name,
            // asSchema() normalises both raw Zod schemas and jsonSchema()-wrapped
            // schemas and exposes the JSON Schema representation at .jsonSchema.
            // Accessing .jsonSchema directly on a raw Zod schema yields undefined,
            // which breaks MCP clients that validate the tools/list response.
            inputSchema: asSchema(t.inputSchema).jsonSchema,
          })),
        },
        id,
      };

    case "tools/call": {
      const params = req.params as { name: string; arguments?: unknown };
      const t = TOOLS[params.name];

      if (!t) {
        return {
          jsonrpc: "2.0",
          error: { code: -32601, message: `Tool not found: ${params.name}` },
          id,
        };
      }

      try {
        const result = await t.execute?.(params.arguments ?? {}, {
          toolCallId: "mcp",
          messages: [],
        });
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
