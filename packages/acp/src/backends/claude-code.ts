/**
 * Claude Code backend.
 *
 * Spawns `claude -p` in stream-json (NDJSON) mode, parses each line as a
 * typed CC event, and translates it to BackendEvent. CC runs its own
 * internal tool loop, so all tool_call / tool_result events are surfaced
 * with observeOnly=true — the agent loop must NOT execute them.
 */

import type { McpServer, McpServerStdio } from "@agentclientprotocol/sdk";
import type { CCBackendConfig } from "../config";
import { getCCModelFlag, isCCModel } from "../routing";
import type { Backend, BackendEvent, BackendRunOptions } from "./types";

// ── ACP → CC MCP config conversion ──

const isStdioServer = (server: McpServer): server is McpServerStdio =>
  "command" in server;

/** Converts an ACP McpServer to the entry format CC's --mcp-config expects. */
const acpServerToConfigEntry = (server: McpServer): Record<string, unknown> => {
  if (isStdioServer(server)) {
    const env = Object.fromEntries(
      (server.env ?? []).map((e) => [e.name, e.value]),
    );
    return {
      type: "stdio",
      command: server.command,
      args: server.args ?? [],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  const headers = Object.fromEntries(
    (server.headers ?? []).map((h) => [h.name, h.value]),
  );
  return {
    type: server.type,
    url: server.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
};

/**
 * Writes the MCP config file consumed by `--mcp-config`, merging the base
 * mimir + context7 servers with any MCP servers provided by the ACP client.
 *
 * Pass a session-specific `mcpConfigPath` when client servers differ per
 * session to avoid concurrent sessions overwriting each other's config.
 */
export const writeMcpConfig = async (
  mcpConfigPath: string,
  serverUrl: string,
  clientMcpServers?: readonly McpServer[],
): Promise<void> => {
  const clientEntries: Record<string, unknown> = {};
  for (const server of clientMcpServers ?? []) {
    clientEntries[server.name] = acpServerToConfigEntry(server);
  }

  const config = {
    mcpServers: {
      // Client-provided servers first so mimir's own servers always win on
      // name collision (mimir and context7 are reserved names).
      ...clientEntries,
      mimir: {
        type: "http",
        url: `${serverUrl}/mcp`,
      },
      context7: {
        type: "stdio",
        command: "bunx",
        args: ["@upstash/context7-mcp"],
      },
    },
  };
  await Bun.write(mcpConfigPath, `${JSON.stringify(config, null, 2)}\n`);
};

// ── CC stream-json event shapes ──

type CCInitEvent = {
  type: "system";
  subtype: "init";
  session_id: string;
  tools?: string[];
};

type CCAssistantEvent = {
  type: "assistant";
  session_id: string;
  message: {
    content: Array<
      | { type: "text"; text: string }
      | { type: "thinking"; thinking: string }
      | {
          type: "tool_use";
          id: string;
          name: string;
          input: Record<string, unknown>;
        }
    >;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
};

type CCToolResultEvent = {
  type: "user";
  session_id: string;
  message: {
    content: Array<
      | {
          type: "tool_result";
          tool_use_id: string;
          content: string | Array<{ type: string; text?: string }>;
        }
      | unknown
    >;
  };
};

type CCResultEvent = {
  type: "result";
  subtype: "success" | "error";
  session_id: string;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

type CCEvent =
  | CCInitEvent
  | CCAssistantEvent
  | CCToolResultEvent
  | CCResultEvent
  | { type: "error"; message?: string }
  | { type: string; [key: string]: unknown };

// ── Helpers ──

const stringifyToolResult = (
  content: CCToolResultEvent["message"]["content"][number],
): string => {
  if (typeof content !== "object" || content === null) return "";
  const c = content as { content?: unknown };
  if (typeof c.content === "string") return c.content;
  if (Array.isArray(c.content)) {
    return c.content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object" && "text" in p) {
          return String((p as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
};

/** Read NDJSON from a ReadableStream<Uint8Array>, yielding parsed objects. */
const iterateNdjson = async function* (
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

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
            yield JSON.parse(line);
          } catch {
            // ignore non-JSON lines (e.g. progress noise)
          }
        }
        nl = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      try {
        yield JSON.parse(tail);
      } catch {
        // ignore
      }
    }
  } finally {
    reader.releaseLock();
  }
};

// ── NDJSON history builder ──

/**
 * Convert an assembled message array to the stream-json NDJSON format
 * that `claude --input-format stream-json` expects on stdin.
 *
 * Each message becomes a JSON line in CC's native event format.
 * A synthetic session_id is used since these are server-synthesized turns,
 * not replayed from an actual CC session.
 */
const SYNTHETIC_SESSION_ID = "synthetic-history";

const buildNdjson = (
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): string =>
  `${messages
    .map((m) =>
      JSON.stringify({
        type: m.role,
        session_id: SYNTHETIC_SESSION_ID,
        message: {
          role: m.role,
          content: [{ type: "text", text: m.content }],
        },
      }),
    )
    .join("\n")}\n`;

// ── Public API ──

export type RunClaudeCodeOptions = {
  /**
   * Pre-assembled messages from mimir-server (context injection pair +
   * historical turns + current user message). Piped as NDJSON via stdin
   * with --input-format stream-json.
   */
  readonly messages: ReadonlyArray<{
    role: "user" | "assistant";
    content: string;
  }>;
  readonly systemPrompt: string;
  readonly workingDirectory: string;
  readonly cc: CCBackendConfig;
  /** The mimir-server URL, needed to build the MCP config's mimir entry. */
  readonly serverUrl: string;
  /** CC --model flag value; e.g. "opus", "sonnet[1m]". */
  readonly model?: string;
  /** MCP servers from the ACP client to merge into the CC MCP config. */
  readonly clientMcpServers?: readonly McpServer[];
  readonly signal?: AbortSignal;
};

export const runClaudeCode = async function* (
  options: RunClaudeCodeOptions,
): AsyncGenerator<BackendEvent> {
  // Write a per-invocation MCP config merging mimir's base servers with any
  // client-provided servers. Using a unique path avoids concurrent sessions
  // overwriting each other's config file.
  const mcpConfigPath = `${options.cc.mcpConfigPath}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;
  await writeMcpConfig(
    mcpConfigPath,
    options.serverUrl,
    options.clientMcpServers,
  );

  // The assembled messages are piped as NDJSON via stdin. The last entry is
  // the current user message, so -p receives an empty string and CC uses
  // the stream as the full conversation.
  const args: string[] = [
    "-p",
    "",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--permission-mode",
    options.cc.permissionMode,
    "--system-prompt",
    options.systemPrompt,
  ];

  if (options.cc.disallowedTools.length > 0) {
    args.push("--disallowedTools", options.cc.disallowedTools.join(","));
  }
  if (options.model) {
    args.push("--model", options.model);
  }

  // Bun is the runtime per package.json; Bun.spawn returns a stream-friendly process.
  const proc = Bun.spawn(["claude", ...args], {
    cwd: options.workingDirectory,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Write conversation history as NDJSON then close stdin so CC knows input is done.
  const ndjson = buildNdjson(options.messages);
  proc.stdin.write(ndjson);
  proc.stdin.end();

  const onAbort = () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  let lastUsage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
  let sessionId: string | undefined;

  try {
    for await (const raw of iterateNdjson(proc.stdout)) {
      const ev = raw as CCEvent;

      if (ev.type === "system" && (ev as CCInitEvent).subtype === "init") {
        const init = ev as CCInitEvent;
        sessionId = init.session_id;
        yield {
          type: "init",
          sessionId: init.session_id,
          tools: init.tools ?? [],
        };
        continue;
      }

      if (ev.type === "assistant") {
        const a = ev as CCAssistantEvent;
        sessionId = a.session_id;
        if (a.message.usage) lastUsage = a.message.usage;

        for (const part of a.message.content ?? []) {
          if (part.type === "text") {
            yield { type: "text", text: part.text };
          } else if (part.type === "thinking") {
            yield { type: "thinking", text: part.thinking };
          } else if (part.type === "tool_use") {
            yield {
              type: "tool_call",
              id: part.id,
              name: part.name,
              input: part.input ?? {},
              observeOnly: true,
            };
          }
        }
        continue;
      }

      if (ev.type === "user") {
        const u = ev as CCToolResultEvent;
        for (const part of u.message?.content ?? []) {
          if (
            part &&
            typeof part === "object" &&
            (part as { type?: string }).type === "tool_result"
          ) {
            const tr = part as {
              tool_use_id: string;
              content: unknown;
            };
            yield {
              type: "tool_result",
              id: tr.tool_use_id,
              output: stringifyToolResult(part as never),
              observeOnly: true,
            };
          }
        }
        continue;
      }

      if (ev.type === "result") {
        const r = ev as CCResultEvent;
        sessionId = r.session_id;
        const usage = r.usage ?? lastUsage;
        const promptTokens =
          (usage?.input_tokens ?? 0) +
          (usage?.cache_read_input_tokens ?? 0) +
          (usage?.cache_creation_input_tokens ?? 0);
        yield {
          type: "finish",
          sessionId,
          stopReason: r.subtype,
          promptTokens,
          completionTokens: usage?.output_tokens,
          cost: r.total_cost_usd,
        };
        return;
      }
    }

    // Stream closed without a result event
    const exit = await proc.exited;
    if (exit !== 0) {
      const err = await new Response(proc.stderr).text().catch(() => "");
      yield {
        type: "error",
        error: `claude exited ${exit}: ${err.slice(0, 500)}`,
      };
    } else {
      yield { type: "finish", sessionId };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield { type: "error", error: msg };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    // Clean up the per-invocation MCP config temp file.
    Bun.file(mcpConfigPath)
      .exists()
      .then((exists) => {
        if (exists) Bun.$`rm -f ${mcpConfigPath}`.quiet().catch(() => {});
      });
  }
};

// ── Backend adapter ──

export type ClaudeCodeBackendDeps = {
  readonly cc: CCBackendConfig;
  /** The mimir-server URL, forwarded into per-invocation MCP configs. */
  readonly serverUrl: string;
  /** Default cwd when ACP doesn't supply a project path. */
  readonly defaultCwd: string;
};

export const createClaudeCodeBackend = (
  deps: ClaudeCodeBackendDeps,
): Backend => {
  const run = async function* (
    options: BackendRunOptions,
  ): AsyncGenerator<BackendEvent> {
    const cwd =
      deps.cc.workingDirectory ?? options.projectPath ?? deps.defaultCwd;

    const model = isCCModel(options.modelId)
      ? getCCModelFlag(options.modelId, deps.cc)
      : undefined;

    yield* runClaudeCode({
      messages: options.assembledMessages ?? [],
      systemPrompt: options.systemPrompt,
      workingDirectory: cwd,
      cc: deps.cc,
      serverUrl: deps.serverUrl,
      model,
      clientMcpServers: options.clientMcpServers,
      signal: options.signal,
    });
  };

  return { kind: "claude-code", run };
};
