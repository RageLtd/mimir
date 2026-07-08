/**
 * Stdio MCP server for Mimir's LOCAL tools — "mimir-local" in mcp.json.
 *
 * Grown from the original user-memory-only server (MIM-84): now serves two
 * tool families from two local SQLite stores:
 *
 *   user_memory_* / user_profile_*  — ~/.mimir/user-memories.db
 *   project_memory_* / project_playbook_* — ~/.mimir/org-replica.db
 *
 * Project-memory reads AND writes are local-only (single-user paradigm;
 * MIM-88's encrypted sync later becomes the multi-member story). The
 * server's /mcp still exposes its own copies of the project tools during
 * the transition — the model should prefer these local ones.
 *
 * Spawned by Claude Code via mcp.json. CC's MCP client speaks JSON-RPC 2.0
 * over stdio; we read newline-delimited JSON from stdin, write responses to
 * stdout, log only to stderr (any stdout chatter would corrupt the JSON-RPC
 * stream and crash the connection).
 *
 * Env: MIMIR_USER_MEMORY_DB — absolute path to the user-memory SQLite db.
 *      MIMIR_ORG_REPLICA_DB — org replica path (default ~/.mimir/org-replica.db).
 *
 * The subcommand stays `user-memory-mcp` so existing installs keep working;
 * only the mcp.json server key and serverInfo say "mimir-local".
 */

import {
  createOrgReplica,
  defaultOrgReplicaPath,
  type OrgReplica,
} from "@mimir/plugin-core/store/org-replica";
import { createUserMemoryStore } from "@mimir/plugin-core/store/user-memories";
import {
  executeOrgMemoryTool,
  orgMemoryToolDefs,
  orgMemoryToolNames,
} from "@mimir/plugin-core/tools/org-memory";
import {
  executeUserMemoryTool,
  userMemoryToolDefs,
} from "@mimir/plugin-core/tools/user-memory";
import { errMessage } from "@mimir/plugin-core/util";

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
 * which happens on session teardown. Stores close in the read-loop
 * teardown path; if Bun terminates before that runs, SQLite's WAL journal
 * survives without corruption.
 */
export const runUserMemoryMcp = async () => {
  const dbPath = process.env.MIMIR_USER_MEMORY_DB;
  if (!dbPath) {
    process.stderr.write("MIMIR_USER_MEMORY_DB is required\n");
    return 1;
  }
  const replicaPath =
    process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath();

  const store = createUserMemoryStore(dbPath);
  // Opening auto-creates an empty replica when the import hasn't run yet —
  // tools then answer honestly ("no memories found") instead of erroring.
  const replica: OrgReplica = createOrgReplica(replicaPath);

  // Convert OpenAI-style tool defs into MCP's expected
  // {name, description, inputSchema} shape.
  const mcpTools = [...userMemoryToolDefs, ...orgMemoryToolDefs].map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    inputSchema: t.function.parameters ?? { type: "object", properties: {} },
  }));

  const handleRequest = async (req: JsonRpcRequest) => {
    const { id, method, params } = req;

    // JSON-RPC notifications (no id) — acknowledge silently.
    if (id === undefined) return;

    switch (method) {
      case "initialize": {
        respond(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mimir-local", version: "2.0.0" },
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
        // embedQuery deliberately absent until MIM-85 wires llama-server —
        // org tools degrade to FTS-only / unembedded stores.
        const result = orgMemoryToolNames.has(name)
          ? await executeOrgMemoryTool(replica, name, args)
          : executeUserMemoryTool(store, name, args);
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

  const processBuffer = async () => {
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        // Parse + dispatch inline. A malformed line is reported as a
        // protocol parse error with null id (no request context).
        const parsed = parseLine(line);
        if (parsed.ok) {
          await handleRequest(parsed.value);
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
      await processBuffer();
    }
  } finally {
    store.close();
    replica.close();
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
