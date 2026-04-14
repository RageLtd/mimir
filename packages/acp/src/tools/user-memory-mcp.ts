/**
 * Minimal stdio MCP server for user memory tools.
 *
 * Runs as a subprocess spawned by Claude Code via --mcp-config.
 * Speaks JSON-RPC 2.0 over stdin/stdout — the MCP stdio transport.
 * Connects to the same bun:sqlite database as the main ACP process.
 *
 * Env: MIMIR_USER_MEMORY_DB — path to the SQLite database file.
 */

import { createUserMemoryStore } from "../store/user-memories";
import { errMessage } from "../util";
import { executeUserMemoryTool, userMemoryToolDefs } from "./user-memory";

const dbPath = process.env.MIMIR_USER_MEMORY_DB;
if (!dbPath) {
  process.stderr.write("MIMIR_USER_MEMORY_DB is required\n");
  process.exit(1);
}

const store = createUserMemoryStore(dbPath);

// ── MCP tool schema conversion ──
// Our tool defs use OpenAI-style { function: { name, parameters } }.
// MCP expects { name, description, inputSchema }.

const mcpTools = userMemoryToolDefs.map((t) => ({
  name: t.function.name,
  description: t.function.description ?? "",
  inputSchema: t.function.parameters ?? { type: "object", properties: {} },
}));

// ── JSON-RPC helpers ──

const respond = (id: string | number, result: unknown) => {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(`${msg}\n`);
};

const respondError = (
  id: string | number | null,
  code: number,
  message: string,
) => {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(`${msg}\n`);
};

// ── Request handling ──

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

const handleRequest = (req: JsonRpcRequest) => {
  const { id, method, params } = req;

  // Notifications (no id) — just acknowledge silently
  if (id === undefined) return;

  switch (method) {
    case "initialize": {
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "user-memory", version: "1.0.0" },
      });
      return;
    }

    case "tools/list": {
      respond(id, { tools: mcpTools });
      return;
    }

    case "tools/call": {
      const name = (params?.name ?? "") as string;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const result = executeUserMemoryTool(store, name, args);
      respond(id, {
        content: [{ type: "text", text: result.content }],
        isError: result.isError ?? false,
      });
      return;
    }

    default: {
      respondError(id, -32601, `Method not found: ${method}`);
    }
  }
};

// ── stdio transport ──
// Read newline-delimited JSON-RPC from stdin.

const decoder = new TextDecoder();
let buffer = "";

const processBuffer = () => {
  let nl = buffer.indexOf("\n");
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) {
      try {
        handleRequest(JSON.parse(line));
      } catch (err) {
        respondError(null, -32700, `Parse error: ${errMessage(err)}`);
      }
    }
    nl = buffer.indexOf("\n");
  }
};

const stdin = Bun.stdin.stream();
const reader = stdin.getReader();

const readLoop = async () => {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    processBuffer();
  }
  store.close();
};

readLoop().catch((err) => {
  process.stderr.write(`user-memory-mcp fatal: ${err}\n`);
  process.exit(1);
});
