/**
 * Claude Code backend adapter.
 *
 * One Query per session, created on the first prompt and reused thereafter
 * via streaming-input mode. Per-turn cancellation goes through
 * `query.interrupt()`; `query.close()` is reserved for compact / dispose
 * paths in core.ts.
 *
 * The adapter branches internally on `session.ccQuery`:
 *   - First turn: `startClaudeCodeSession` creates the Query, stores
 *     `ccQuery` / `ccUserStreamPush` / `ccEvents` / `ccQueryConfig` on the
 *     session, and yields events from the long-lived stream until `finish`.
 *   - Subsequent turns: detect mid-session config drift (model/mode/effort)
 *     against `ccQueryConfig`, apply `setModel` / `setPermissionMode`, or
 *     tear down + recreate when effort changes (no SDK setEffort). Then
 *     push the new user message and yield events until the next `finish`.
 */

import type { SessionState } from "../../agent/types";
import type { CCBackendConfig } from "../../config";
import { getCCModelFlag, isCCModel } from "../../routing";
import type { Backend, BackendRunOptions } from "../types";
import { toCanUseTool } from "./permissions";
import { feedClaudeCodeMessage, startClaudeCodeSession } from "./runner";

export type ClaudeCodeBackendDeps = {
  readonly cc: CCBackendConfig;
  /** The mimir-server URL, forwarded into per-invocation MCP configs. */
  readonly serverUrl: string;
  /** Path to the user memory SQLite database, forwarded to the MCP server config. */
  readonly userMemoryDbPath: string;
  /** Default cwd when ACP doesn't supply a project path. */
  readonly defaultCwd: string;
};

const requireSession = (options: BackendRunOptions) => {
  if (!options.session) {
    throw new Error(
      "claude-code backend requires options.session — caller must pass SessionState through BackendRunOptions",
    );
  }
  return options.session;
};

const tearDown = (session: SessionState) => {
  session.ccQuery?.close();
  session.ccQuery = null;
  session.ccUserStreamPush = null;
  session.ccEvents = null;
  session.ccQueryConfig = null;
};

export const createClaudeCodeBackend = (deps: ClaudeCodeBackendDeps) => {
  const run = async function* (options: BackendRunOptions) {
    const session = requireSession(options);

    const cwd =
      deps.cc.workingDirectory ?? options.projectPath ?? deps.defaultCwd;

    const model = isCCModel(options.modelId)
      ? getCCModelFlag(options.modelId, deps.cc)
      : undefined;

    // Effort changes require recreation (no SDK setEffort).
    if (
      session.ccQuery &&
      session.ccQueryConfig &&
      session.ccQueryConfig.effort !== options.effort
    ) {
      tearDown(session);
    }

    if (!session.ccQuery) {
      const canUseTool = options.requestToolPermission
        ? toCanUseTool(options.requestToolPermission)
        : undefined;

      const cc = startClaudeCodeSession({
        prompt: options.prompt,
        promptBlocks: options.promptBlocks,
        systemPrompt: options.systemPrompt,
        workingDirectory: cwd,
        cc: deps.cc,
        serverUrl: deps.serverUrl,
        userMemoryDbPath: deps.userMemoryDbPath,
        model,
        clientMcpServers: options.clientMcpServers,
        permissionMode: options.permissionMode,
        effort: options.effort,
        rules: options.rules,
        canUseTool,
      });
      session.ccQuery = cc.query;
      session.ccUserStreamPush = cc.push;
      session.ccEvents = cc.events;
      session.ccQueryConfig = {
        modelId: options.modelId,
        mode: options.permissionMode ?? "",
        effort: options.effort,
      };
    } else {
      // Apply mid-session setters before pushing the next message.
      const cfg = session.ccQueryConfig;
      if (cfg && model && cfg.modelId !== options.modelId) {
        await session.ccQuery.setModel(model);
        cfg.modelId = options.modelId;
      }
      const newMode = options.permissionMode ?? "";
      if (cfg && options.permissionMode && cfg.mode !== newMode) {
        await session.ccQuery.setPermissionMode(options.permissionMode);
        cfg.mode = newMode;
      }
      if (!session.ccUserStreamPush) {
        throw new Error(
          "ccQuery is set but ccUserStreamPush is null — invariant violated",
        );
      }
      feedClaudeCodeMessage(
        session.ccUserStreamPush,
        options.prompt,
        options.promptBlocks,
      );
    }

    yield* drainUntilFinish(session, options.signal);
  };

  return { kind: "claude-code" as const, run } satisfies Backend;
};

/**
 * Drain `session.ccEvents` until a `finish` event surfaces, forwarding
 * each one. When `signal` aborts, call `query.interrupt()` and continue
 * draining until the SDK emits its interrupt result. The events generator
 * stays paused after `finish` so the next ACP turn can resume.
 */
async function* drainUntilFinish(
  session: SessionState,
  signal: AbortSignal | undefined,
) {
  if (!session.ccEvents) {
    throw new Error("ccEvents is null — drain called before start");
  }

  let interrupted = false;
  const onAbort = () => {
    if (interrupted) return;
    interrupted = true;
    session.ccQuery?.interrupt().catch(() => {
      // SDK throws if the turn is already finishing; harmless.
    });
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    for (;;) {
      const next = await session.ccEvents.next();
      if (next.done) return;
      const event = next.value;
      yield event;
      if (event.type === "finish") return;
    }
  } finally {
    if (signal && !signal.aborted) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
