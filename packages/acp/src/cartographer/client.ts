/**
 * MCP client for the cartographer Rust binary.
 *
 * Spawns the binary as a child process, communicates via JSON-RPC 2.0
 * over stdio (the MCP transport). Provides typed wrappers for the
 * cartographer tools we need to call locally.
 *
 * The binary auto-indexes CWD on startup, so spawning it with the
 * project root as cwd triggers a full index automatically.
 */

import { createChildLogger, log } from "../utils/log";

const logger = createChildLogger(log, "cartographer-client");

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

// ── MCP tool result shape ──

type McpToolResult = {
  content: { type: string; text?: string }[];
  isError?: boolean;
};

// ── Parsed output shapes from cartographer tools ──

export type ParsedFileOutput = {
  filePath: string;
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

export type DetectChangesOutput = {
  indexed: number;
  removed: number;
  modified: string[];
  deleted: string[];
};

export type StatsOutput = {
  totalFiles: number;
  totalImportEdges: number;
  languages: Record<string, number>;
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
  /** Run full project index. Returns count string. */
  readonly indexProject: (project: string) => Promise<string>;
  /** Detect git changes and re-index. Returns structured output. */
  readonly detectChanges: (project: string) => Promise<DetectChangesOutput>;
  /** Get index stats. */
  readonly stats: (project: string) => Promise<StatsOutput>;
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

  // Read stdout in background, dispatch responses to pending requests
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
              const msg = JSON.parse(line) as JsonRpcResponse;
              if (typeof msg.id === "number") {
                const p = pending.get(msg.id);
                if (p) {
                  pending.delete(msg.id);
                  p.resolve(msg);
                }
              }
            } catch (err) {
              logger.debug(
                "non-JSON line from cartographer:",
                line.slice(0, 120),
                err instanceof Error ? err.message : "",
              );
            }
          }
          nl = buffer.indexOf("\n");
        }
      }
    } catch (err) {
      logger.debug(
        "stdout read loop ended:",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      reader.releaseLock();
      // Reject all pending requests
      for (const [, p] of pending) {
        p.reject(new Error("cartographer process exited"));
      }
      pending.clear();
    }
  };
  readLoop();

  // Drain stderr for logging
  const stderrLoop = async () => {
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true }).trim();
        if (text) logger.debug("cartographer stderr:", text);
      }
    } catch (err) {
      logger.debug(
        "stderr read loop ended:",
        err instanceof Error ? err.message : String(err),
      );
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

  // Initialize the MCP connection
  const initResponse = await send({
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mimir-acp", version: "1.0.0" },
    },
  });

  if (initResponse.error) {
    proc.kill();
    throw new Error(
      `cartographer MCP init failed: ${initResponse.error.message}`,
    );
  }

  // Send initialized notification (no response expected)
  writer.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );

  logger.info("cartographer MCP client connected, cwd:", cwd);

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

    const result = response.result as McpToolResult;
    const textParts = (result.content ?? [])
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
    return JSON.parse(text) as ParsedFileOutput;
  };

  const indexProject = async (project: string): Promise<string> => {
    return callTool("cartographer_index_project", { project });
  };

  const detectChanges = async (
    project: string,
  ): Promise<DetectChangesOutput> => {
    const text = await callTool("cartographer_detect_changes", { project });
    // detect_changes returns either plain text ("No changes") or JSON
    try {
      return JSON.parse(text) as DetectChangesOutput;
    } catch (err) {
      logger.debug(
        "detect_changes returned non-JSON, treating as no changes:",
        err instanceof Error ? err.message : String(err),
      );
      return { indexed: 0, removed: 0, modified: [], deleted: [] };
    }
  };

  const stats = async (project: string): Promise<StatsOutput> => {
    const text = await callTool("cartographer_stats", { project });
    return JSON.parse(text) as StatsOutput;
  };

  const isAlive = () => {
    try {
      return proc.exitCode === null;
    } catch (err) {
      logger.debug(
        "isAlive check failed, treating as dead:",
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  };

  const kill = () => {
    try {
      proc.kill();
    } catch (err) {
      logger.debug(
        "kill failed (process likely already dead):",
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  return {
    callTool,
    parseFile,
    indexProject,
    detectChanges,
    stats,
    isAlive,
    kill,
  };
};
