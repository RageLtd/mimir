/**
 * Short-lived MCP client for the cartographer Rust binary.
 *
 * Spawns the binary as a child process in `--parse-only` mode and speaks
 * JSON-RPC 2.0 over stdio (the MCP transport). The reindex hook spawns
 * one client per tool-call, parses the changed file, sends the result
 * upstream, and kills the process — no long-lived state, no auto-index
 * on startup (the hook drives parsing explicitly per file).
 *
 * Ported from packages/acp/src/cartographer/client.ts, trimmed to the
 * single `parseFile` surface used by the reindex path. Logging is
 * routed to stderr instead of the structured logger in the monorepo.
 */

import { createLogger } from "../logger";
import { parseJSON } from "../util";

const log = createLogger("cartographer-client");

// ── JSON-RPC types ──

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type McpToolResult = {
  content: { type: string; text?: string }[];
  isError?: boolean;
};

// ── Parsed output shapes from cartographer tools ──

export type ParsedFileOutput = {
  file_path: string;
  language: string;
  imports: { target: string; specifier: string; symbols: string[] }[];
  symbols: {
    name: string;
    kind: string;
    signature: string;
    docComment: string | null;
    visibility: string;
    line: number;
  }[];
};

// ── Client ──

export type CartographerClient = {
  /** Call an MCP tool on the binary and return the raw text result. */
  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
  /** Parse a single file. Returns structured output. */
  readonly parseFile: (
    project: string,
    filePath: string,
  ) => Promise<ParsedFileOutput>;
  /** Whether the process is alive. */
  readonly isAlive: () => boolean;
  /** Kill the child process. */
  readonly kill: () => void;
};

/**
 * Spawn the cartographer binary as an MCP server and return a client.
 *
 * The binary auto-indexes cwd on startup if it looks like a project
 * directory. Set `cwd` to the project root for automatic indexing.
 */
export const spawnCartographer = async (
  binaryPath: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<CartographerClient> => {
  const proc = Bun.spawn([binaryPath, "--parse-only"], {
    cwd,
    stdout: "pipe",
    stdin: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });

  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (value: JsonRpcResponse) => void;
      reject: (err: Error) => void;
    }
  >();

  const decoder = new TextDecoder();
  let buffer = "";

  // Read stdout in background, dispatch responses to pending requests.
  const readLoop = async () => {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.length > 0) {
            try {
              const msg = parseJSON<JsonRpcResponse>(line);
              if (typeof msg.id === "number") {
                const p = pending.get(msg.id);
                if (p) {
                  pending.delete(msg.id);
                  p.resolve(msg);
                }
              }
            } catch (err) {
              log.debug("non-JSON line from cartographer", {
                line: line.slice(0, 120),
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          nl = buffer.indexOf("\n");
        }
      }
    } catch (err) {
      log.debug("stdout read loop ended", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      reader.releaseLock();
      for (const [, p] of pending) {
        p.reject(new Error("cartographer process exited"));
      }
      pending.clear();
    }
  };
  readLoop();

  // Drain stderr so the child doesn't block on a full pipe.
  const stderrLoop = async () => {
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true }).trim();
        if (text) log.debug("cartographer stderr", { text });
      }
    } catch (err) {
      log.debug("stderr read loop ended", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      reader.releaseLock();
    }
  };
  stderrLoop();

  const writer = proc.stdin;

  const send = (msg: JsonRpcRequest): Promise<JsonRpcResponse> => {
    return new Promise((resolve, reject) => {
      pending.set(msg.id, { resolve, reject });
      const data = `${JSON.stringify(msg)}\n`;
      writer.write(data);
    });
  };

  // MCP handshake.
  const initResponse = await send({
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mimir-cc", version: "1.0.0" },
    },
  });

  if (initResponse.error) {
    proc.kill();
    throw new Error(
      `cartographer MCP init failed: ${initResponse.error.message}`,
    );
  }

  writer.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  log.info("connected", { cwd });

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    const response = await send({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });

    if (response.error) {
      throw new Error(
        `cartographer tool ${name} failed: ${response.error.message}`,
      );
    }

    const raw = response.result;
    const content =
      raw &&
      typeof raw === "object" &&
      "content" in raw &&
      Array.isArray((raw as McpToolResult).content)
        ? (raw as McpToolResult).content
        : [];
    const textParts = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text ?? "");
    return textParts.join("\n");
  };

  const parseFile = async (
    project: string,
    filePath: string,
  ): Promise<ParsedFileOutput> => {
    const text = await callTool("cartographer_parse_file", {
      project,
      file_path: filePath,
    });
    const parsed = JSON.parse(text) as ParsedFileOutput;
    // Cartographer's parse_file tool omits file_path from its output
    // (the caller already supplied it). Stamp it back so downstream
    // sync payload assembly doesn't have to special-case the gap.
    return { ...parsed, file_path: parsed.file_path ?? filePath };
  };

  const isAlive = () => {
    try {
      return proc.exitCode === null;
    } catch (err) {
      log.debug("isAlive check failed, treating as dead", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  const kill = () => {
    try {
      proc.kill();
    } catch (err) {
      log.debug("kill failed (process likely already dead)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return { callTool, parseFile, isAlive, kill };
};
