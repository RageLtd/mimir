/**
 * Stdio MCP server for user-memory tools.
 *
 * Spawned by Claude Code via mcp.json. CC's MCP client speaks JSON-RPC 2.0
 * over stdio; we read newline-delimited JSON from stdin, write responses to
 * stdout, log only to stderr (any stdout chatter would corrupt the JSON-RPC
 * stream and crash the connection).
 *
 * Env: MIMIR_USER_MEMORY_DB — absolute path to the SQLite database.
 *
 * Ported from packages/acp/src/tools/user-memory-mcp.ts. Adapted to live
 * inside the compiled mimir-cc binary as the `user-memory-mcp` subcommand,
 * so mcp.json points at `mimir-cc` rather than a bun script.
 */

import { createUserMemoryStore } from "./store/user-memories";
import { executeUserMemoryTool, userMemoryToolDefs } from "./tools/user-memory";
import { errMessage } from "./util";

// ── JSON-RPC types ──

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

// ── Helpers ──

const writeMessage = (message: unknown) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const respond = (id: string | number, result: unknown) => {
  writeMessage({ jsonrpc: "2.0", id, result });
};

const respondError = (
  id: string | number | null,
  code: number,
  message: string,
) => {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
};

/**
 * Entry point invoked from cli.ts when argv[2] === "user-memory-mcp".
 * Returns a process exit code; the caller drives process.exit().
 *
 * Connection lifetime: keeps reading stdin until the parent (CC) closes it,
 * which happens on session teardown. The store is closed in the read-loop
 * teardown path; if Bun terminates before that runs, SQLite's WAL journal
 * survives without corruption.
 */
export const runUserMemoryMcp = async (): Promise<number> => {
  const dbPath = process.env.MIMIR_USER_MEMORY_DB;
  if (!dbPath) {
    process.stderr.write("MIMIR_USER_MEMORY_DB is required\n");
    return 1;
  }

  const store = createUserMemoryStore(dbPath);

  // Convert OpenAI-style tool defs into MCP's expected
  // {name, description, inputSchema} shape.
  const mcpTools = userMemoryToolDefs.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    inputSchema: t.function.parameters ?? { type: "object", properties: {} },
  }));

  const handleRequest = (req: JsonRpcRequest) => {
    const { id, method, params } = req;

    // JSON-RPC notifications (no id) — acknowledge silently.
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

  const decoder = new TextDecoder();
  let buffer = "";

  const processBuffer = () => {
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        // Parse + dispatch inline. A malformed line is reported as a
        // protocol parse error with null id (no request context).
        const parsed = parseLine(line);
        if (parsed.ok) {
          handleRequest(parsed.value);
        } else {
          respondError(null, -32700, `Parse error: ${parsed.error}`);
        }
      }
      nl = buffer.indexOf("\n");
    }
  };

  const reader = Bun.stdin.stream().getReader();

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      processBuffer();
    }
  } finally {
    store.close();
  }

  return 0;
};

type ParseResult =
  | { readonly ok: true; readonly value: JsonRpcRequest }
  | { readonly ok: false; readonly error: string };

const parseLine = (line: string): ParseResult => {
  try {
    return { ok: true, value: JSON.parse(line) as JsonRpcRequest };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
};
