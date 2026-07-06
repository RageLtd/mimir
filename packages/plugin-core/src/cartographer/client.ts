/**
 * Short-lived MCP client for the cartographer Rust binary.
 *
 * Spawns the binary as a child process in `--parse-only` mode and speaks
 * JSON-RPC 2.0 over stdio (the MCP transport). The reindex hook spawns
 * one client per tool-call, parses the changed file, sends the result
 * upstream, and kills the process — no long-lived state, no auto-index
 * on startup (the hook drives parsing explicitly per file).
 *
 * Originally in packages/cc-plugin/src/cartographer/client.ts; the
 * acp adapter's larger client (with `indexProject`, `detectChanges`,
 * `stats`) wraps this base.
 *
 * Error handling: per the mimir monorepo convention, errors propagate
 * rather than being swallowed. The background read/stderr loops attach
 * a single `.catch()` at the call site (they're fire-and-forget) so
 * unhandled rejections are logged but the cleanup still runs via
 * `finally`. Per-request parse failures use `attempt()` and skip the
 * malformed line — a single bad line from the binary should not crash
 * the rest of the stream.
 */

import { createLoggerFactory } from "../logger";
import { attempt } from "../result";
import { parseJSON } from "../util";

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
  const log = createLoggerFactory("mimir-plugin").createLogger(
    "cartographer-client",
  );

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
  // try/finally guarantees the reader is released and pending requests
  // are rejected whether the loop completes normally or the stream
  // errors. The call-site `.catch()` logs stream errors so we don't
  // get an unhandled rejection.
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
            const [parseErr, msg] = await attempt(async () =>
              parseJSON<JsonRpcResponse>(line),
            );
            if (parseErr) {
              // Cartographer can emit non-JSON debug lines; skip them
              // and keep reading rather than tearing down the stream.
              log.debug("non-JSON line from cartographer", {
                line: line.slice(0, 120),
                error: parseErr.message,
              });
            } else if (typeof msg.id === "number") {
              const p = pending.get(msg.id);
              if (p) {
                pending.delete(msg.id);
                p.resolve(msg);
              }
            }
          }
          nl = buffer.indexOf("\n");
        }
      }
    } finally {
      reader.releaseLock();
      for (const [, p] of pending) {
        p.reject(new Error("cartographer process exited"));
      }
      pending.clear();
    }
  };
  readLoop().catch((err: Error) => {
    log.debug("stdout read loop ended", { error: err.message });
  });

  // Drain stderr so the child doesn't block on a full pipe. Same
  // pattern as readLoop: cleanup via finally, log via call-site catch.
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
    } finally {
      reader.releaseLock();
    }
  };
  stderrLoop().catch((err: Error) => {
    log.debug("stderr read loop ended", { error: err.message });
  });

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
      clientInfo: { name: "mimir-plugin", version: "1.0.0" },
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
    // JSON.parse throws on invalid output; the caller (reindex hook)
    // catches and logs. Don't wrap in attempt() — there's no Result
    // branch we want to take here, the throw IS the branch.
    const parsed = JSON.parse(text) as ParsedFileOutput;
    // Cartographer's parse_file tool omits file_path from its output
    // (the caller already supplied it). Stamp it back so downstream
    // sync payload assembly doesn't have to special-case the gap.
    return { ...parsed, file_path: parsed.file_path ?? filePath };
  };

  // No try/catch guards: `proc.exitCode` is a property access that
  // doesn't throw on a valid Subprocess, and `proc.kill()` is only
  // safe to call when the process is alive. Checking the state first
  // means errors from the kill call (e.g. already-dead process) are
  // visible to the caller rather than silently swallowed.
  const isAlive = () => proc.exitCode === null;

  const kill = () => {
    if (proc.exitCode === null) proc.kill();
  };

  return { callTool, parseFile, isAlive, kill };
};
