/**
 * Stdio MCP server for reading Mimir plugin logs.
 *
 * Exposes two tools:
 *   - read_cc_plugin_logs  — tail ~/.mimir/logs/mimir-cc.log
 *   - read_acp_logs        — tail ~/.mimir/logs/acp.log
 *
 * Both support a `lines` param (default 100, max 500) and an optional
 * `filter` (case-insensitive substring match). Previous-session logs
 * are available via `previous: true`.
 *
 * Spawned by Claude Code via mcp.json as the `mimir-log-mcp` subcommand.
 * Reads JSON-RPC 2.0 from stdin, writes responses to stdout, logs only
 * to stderr (stdout is the protocol stream).
 */

import { join } from "node:path";

import { errMessage, mimirHome } from "@mimir/plugin-core/util";

// ── Log file paths ──

const LOGS_DIR = () => join(mimirHome(), "logs");

const LOG_FILES = {
  cc: { current: "mimir-cc.log", prev: "mimir-cc.prev.log" },
  acp: { current: "acp.log", prev: "acp.prev.log" },
};

// ── Tool definitions ──

const TOOLS = [
  {
    name: "read_cc_plugin_logs",
    description:
      "Read the CC plugin's hook logs (session-start, reindex, file-context, retrieve, persist, voice-anchor). Use to diagnose cartographer sync failures, project resolution issues, boot context assembly errors, or hook timing.",
    inputSchema: {
      type: "object",
      properties: {
        lines: {
          type: "number",
          description:
            "Number of recent lines to return (default: 100, max: 500)",
        },
        filter: {
          type: "string",
          description: "Case-insensitive substring filter",
        },
        previous: {
          type: "boolean",
          description:
            "Read the previous session's log instead of the current one",
        },
      },
    },
  },
  {
    name: "read_acp_logs",
    description:
      "Read the ACP (Zed agent) logs — model routing, tool execution, SSE parsing, permission handling, cartographer lifecycle. Use to diagnose Zed-side issues, server backend errors, or streaming problems.",
    inputSchema: {
      type: "object",
      properties: {
        lines: {
          type: "number",
          description:
            "Number of recent lines to return (default: 100, max: 500)",
        },
        filter: {
          type: "string",
          description: "Case-insensitive substring filter",
        },
        previous: {
          type: "boolean",
          description:
            "Read the previous session's log instead of the current one",
        },
      },
    },
  },
];

// ── Log reader ──

const readLogFile = async (
  source: "cc" | "acp",
  lines?: number,
  filter?: string,
  previous?: boolean,
) => {
  const maxLines = Math.min(lines ?? 100, 500);
  const fileSet = LOG_FILES[source];
  const fileName = previous ? fileSet.prev : fileSet.current;
  const filePath = join(LOGS_DIR(), fileName);

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return {
      success: false,
      error: `Log file not found: ${filePath}`,
      lines: [],
    };
  }

  const text = await file.text().catch((err) => {
    return `__ERROR__:${errMessage(err)}`;
  });

  if (text.startsWith("__ERROR__:")) {
    return {
      success: false,
      error: `Failed to read ${filePath}: ${text.slice(10)}`,
      lines: [],
    };
  }

  const allLines = text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);

  const filtered = filter
    ? allLines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : allLines;

  const result = filtered.slice(-maxLines);

  return {
    success: true,
    error: null,
    file: fileName,
    totalLines: allLines.length,
    returnedLines: result.length,
    lines: result,
  };
};

// ── JSON-RPC dispatch ──

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

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

const parseLine = (line: string) => {
  // JSON.parse can only signal failure via exceptions — this is a
  // serialization boundary, not control flow.
  try {
    return { ok: true as const, value: JSON.parse(line) as JsonRpcRequest };
  } catch (e) {
    return { ok: false as const, error: errMessage(e) };
  }
};

const handleRequest = async (req: JsonRpcRequest) => {
  const { id, method, params } = req;
  if (id === undefined) return;

  switch (method) {
    case "initialize": {
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mimir-logs", version: "1.0.0" },
      });
      return;
    }

    case "tools/list": {
      respond(id, { tools: TOOLS });
      return;
    }

    case "tools/call": {
      const name = (params?.name ?? "") as string;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;

      const source =
        name === "read_cc_plugin_logs"
          ? "cc"
          : name === "read_acp_logs"
            ? "acp"
            : null;

      if (!source) {
        respond(id, {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        });
        return;
      }

      const result = await readLogFile(
        source,
        typeof args.lines === "number" ? args.lines : undefined,
        typeof args.filter === "string" ? args.filter : undefined,
        typeof args.previous === "boolean" ? args.previous : undefined,
      );

      respond(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: !result.success,
      });
      return;
    }

    default: {
      respondError(id, -32601, `Method not found: ${method}`);
    }
  }
};

/**
 * Entry point invoked from cli.ts when argv[2] === "log-mcp".
 */
export const runLogMcp = async () => {
  const decoder = new TextDecoder();
  let buffer = "";

  const processBuffer = async () => {
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
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

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    await processBuffer();
  }

  return 0;
};
