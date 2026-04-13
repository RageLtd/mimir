/**
 * Claude Code backend.
 *
 * Spawns `claude -p` in stream-json (NDJSON) mode, parses each line as a
 * typed CC event, and translates it to BackendEvent. CC runs its own
 * internal tool loop, so all tool_call / tool_result events are surfaced
 * with observeOnly=true — the agent loop must NOT execute them.
 */

import type { CCBackendConfig } from "../config";
import { getCCModelFlag, isCCModel } from "../routing";
import type { Backend, BackendEvent, BackendRunOptions } from "./types";

/**
 * Writes the MCP config file consumed by `--mcp-config`, injecting the
 * correct server URL at startup rather than relying on a hardcoded file.
 * Call once before the first CC spawn.
 */
export const writeMcpConfig = async (
  mcpConfigPath: string,
  serverUrl: string,
): Promise<void> => {
  const config = {
    mcpServers: {
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

// ── Public API ──

export type RunClaudeCodeOptions = {
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly resumeSessionId?: string;
  readonly workingDirectory: string;
  readonly cc: CCBackendConfig;
  /** CC --model flag value; e.g. "opus", "sonnet[1m]". */
  readonly model?: string;
  readonly signal?: AbortSignal;
};

export const runClaudeCode = async function* (
  options: RunClaudeCodeOptions,
): AsyncGenerator<BackendEvent> {
  const args: string[] = [
    "-p",
    options.prompt,
    "--system-prompt",
    options.systemPrompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--mcp-config",
    options.cc.mcpConfigPath,
    "--permission-mode",
    options.cc.permissionMode,
  ];

  if (options.cc.disallowedTools.length > 0) {
    args.push("--disallowedTools", options.cc.disallowedTools.join(","));
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }

  // Bun is the runtime per package.json; Bun.spawn returns a stream-friendly process.
  const proc = Bun.spawn(["claude", ...args], {
    cwd: options.workingDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });

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
  }
};

// ── Backend adapter ──

export type ClaudeCodeBackendDeps = {
  readonly cc: CCBackendConfig;
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
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      resumeSessionId: options.ccResumeSessionId,
      workingDirectory: cwd,
      cc: deps.cc,
      model,
      signal: options.signal,
    });
  };

  return { kind: "claude-code", run };
};
