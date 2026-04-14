/**
 * Core Claude Code subprocess runner.
 *
 * Spawns `claude --input-format stream-json`, writes the current user
 * message as a single NDJSON line to a temp file (passed as stdin), parses
 * stream-json OUTPUT events, and translates them to BackendEvent. Writing
 * via a temp file rather than a pipe avoids macOS's ~65 KB pipe buffer
 * ceiling — large context windows would deadlock a pipe. CC runs its own
 * internal tool loop, so all tool_call / tool_result events are surfaced
 * with observeOnly=true — the agent loop must NOT execute them.
 */

import { acpBlocksToAnthropicContent } from "../../agent/content";
import { errMessage } from "../../util";
import type { BackendEvent } from "../types";
import { buildArgs, type RunClaudeCodeOptions } from "./formatting";
import { writeMcpConfig } from "./mcp-config";
import {
  type CCAssistantEvent,
  type CCEvent,
  type CCInitEvent,
  type CCResultEvent,
  type CCToolResultEvent,
  iterateNdjson,
  stringifyToolResult,
} from "./protocol";

export const runClaudeCode = async function* (
  options: RunClaudeCodeOptions,
): AsyncGenerator<BackendEvent> {
  // Write a per-invocation MCP config merging mimir's base servers with any
  // client-provided servers. Using a unique path avoids concurrent sessions
  // overwriting each other's config file.
  const suffix = `${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;
  const mcpConfigPath = `${options.cc.mcpConfigPath}.${suffix}`;

  // Build the NDJSON user message. Use promptBlocks if available (preserves
  // images); fall back to plain text. Write to a temp file rather than
  // piping directly — macOS's ~65 KB pipe buffer would deadlock on large
  // context. File reads have no such ceiling.
  const contentParts =
    options.promptBlocks && options.promptBlocks.length > 0
      ? acpBlocksToAnthropicContent(options.promptBlocks)
      : [{ type: "text" as const, text: options.prompt }];
  const inputPath = `/tmp/mimir-input-${suffix}.ndjson`;

  await Promise.all([
    writeMcpConfig(
      mcpConfigPath,
      options.serverUrl,
      options.userMemoryDbPath,
      options.clientMcpServers,
    ),
    Bun.write(
      inputPath,
      `${JSON.stringify({ type: "user", message: { role: "user", content: contentParts } })}\n`,
    ),
  ]);

  const args = buildArgs(options, mcpConfigPath);

  const proc = Bun.spawn(["claude", ...args], {
    cwd: options.workingDirectory,
    stdin: Bun.file(inputPath),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ENABLE_TOOL_SEARCH: "false" },
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
    yield { type: "error", error: errMessage(err) };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    // Clean up per-invocation temp files (MCP config + stdin input).
    for (const path of [mcpConfigPath, inputPath]) {
      Bun.file(path)
        .exists()
        .then((exists) => {
          if (exists) Bun.$`rm -f ${path}`.quiet().catch(() => {});
        });
    }
  }
};
