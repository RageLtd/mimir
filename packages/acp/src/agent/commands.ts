/**
 * Slash command execution.
 *
 * Parses and dispatches in-chat commands (`/model`, `/mode`, `/compact`,
 * `/memory *`) against the agent core and streams the response back to the
 * editor. Each command is a small standalone function to keep the switch
 * flat and individually reviewable.
 */

import * as path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { UserMemoryStore } from "@mimir/plugin-core/store/user-memories";
import { assembleClientMcpServers } from "../mcp-config/assemble";
import { authenticateServer } from "../mcp-config/auth-injector";
import { probeHttpServer } from "../mcp-config/probe";
import { runHygiene } from "./hygiene-command";
import { emitAgentText } from "./lifecycle-helpers";
import {
  buildRulesGeneratePrompt,
  findOrphanedRuleBodies,
} from "./rules-generate";
import type { ParsedCommand } from "./session";
import type { AgentCore, SessionState } from "./types";

export type CommandDeps = {
  readonly core: AgentCore;
  readonly conn: acp.AgentSideConnection;
  readonly memoryStore: UserMemoryStore;
  readonly buildSessionConfigOptions: (
    session: SessionState,
  ) => acp.SessionConfigOption[];
};

const END_TURN: acp.PromptResponse = { stopReason: "end_turn" };

const runModel = async (
  deps: CommandDeps,
  sessionId: string,
  modelId: string | undefined,
) => {
  if (!modelId) {
    await emitAgentText(deps.conn, sessionId, "Usage: `/model <model-id>`");
    return END_TURN;
  }
  const ok = deps.core.setModel(sessionId, modelId);
  await emitAgentText(
    deps.conn,
    sessionId,
    ok ? `Model switched to \`${modelId}\`.` : "Session not found.",
  );
  return END_TURN;
};

/**
 * The set of mode values the active backend advertises for this session.
 * Empty when the backend has no mode catalogue (the server backend does
 * not yet surface modes). `/mode` validates against this so wiring server
 * modes later needs only a `"mode"` config option — no command changes.
 */
const activeModeValues = (deps: CommandDeps, sessionId: string) => {
  const session = deps.core.getSession(sessionId);
  if (!session) return [];
  const opt = deps
    .buildSessionConfigOptions(session)
    .find((o) => o.id === "mode");
  if (opt?.type !== "select") return [];
  return (opt.options as { value: string }[]).map((o) => o.value);
};

const listActiveModes = (deps: CommandDeps, sessionId: string) => {
  const values = activeModeValues(deps, sessionId);
  if (values.length === 0) return "(none — backend has no mode catalogue)";
  return values.map((v) => `\`${v}\``).join(", ");
};

const runMode = async (
  deps: CommandDeps,
  sessionId: string,
  modeId: string | undefined,
) => {
  if (!modeId) {
    const list = listActiveModes(deps, sessionId);
    await emitAgentText(
      deps.conn,
      sessionId,
      `Usage: \`/mode <id>\`\nAvailable modes: ${list}`,
    );
    return END_TURN;
  }
  if (!activeModeValues(deps, sessionId).includes(modeId)) {
    const list = listActiveModes(deps, sessionId);
    await emitAgentText(
      deps.conn,
      sessionId,
      `Unknown mode \`${modeId}\`. Available: ${list}`,
    );
    return END_TURN;
  }
  const ok = deps.core.setMode(sessionId, modeId);
  if (!ok) {
    await emitAgentText(deps.conn, sessionId, "Session not found.");
    return END_TURN;
  }
  await deps.conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "current_mode_update",
      currentModeId: modeId,
    },
  });
  await emitAgentText(deps.conn, sessionId, `Mode switched to **${modeId}**.`);
  return END_TURN;
};

const runCompact = async (deps: CommandDeps, sessionId: string) => {
  deps.core.compact(sessionId);
  await emitAgentText(deps.conn, sessionId, "Session history cleared.");
  return END_TURN;
};

const runMcpReload = async (deps: CommandDeps, sessionId: string) => {
  const session = deps.core.getSession(sessionId);
  if (!session) {
    await emitAgentText(deps.conn, sessionId, "Session not found.");
    return END_TURN;
  }
  // Re-read `.mcp.json` (project + global), re-merge with the original
  // client-supplied list snapshotted at session start, and re-inject any
  // persisted Bearer tokens. Replace the session's effective list and rebuild
  // the client-MCP manager so the server backend gets fresh connections; the
  // CC backend gets fresh ones via the rotation flag below.
  const authedServers = await assembleClientMcpServers(
    session.projectPath,
    session.clientSuppliedMcpServers,
  );
  deps.core.replaceMcpServers(sessionId, authedServers);
  // Each `query()` is a fresh SDK session, so the rebuilt server list takes
  // effect on the next prompt automatically — no rotation flag needed.
  await emitAgentText(
    deps.conn,
    sessionId,
    `Re-scanned \`.mcp.json\` — ${authedServers.length} server${authedServers.length === 1 ? "" : "s"} configured. MCP servers will reconnect on your next prompt; newly-available tools (e.g. after an OAuth flow) will become visible then.`,
  );
  return END_TURN;
};

const runMcpList = async (deps: CommandDeps, sessionId: string) => {
  const session = deps.core.getSession(sessionId);
  if (!session) {
    await emitAgentText(deps.conn, sessionId, "Session not found.");
    return END_TURN;
  }
  const servers = session.clientMcpServers ?? [];
  if (servers.length === 0) {
    await emitAgentText(
      deps.conn,
      sessionId,
      "No MCP servers configured for this session.",
    );
    return END_TURN;
  }
  // Probe HTTP servers in parallel — total wait is the slowest server's
  // round-trip rather than the sum. Stdio servers aren't probed (spawning
  // the binary just to count tools is heavier than the value warrants).
  const lines = await Promise.all(
    servers.map(async (s) => {
      if ("command" in s) {
        return `- **${s.name}** (stdio: \`${s.command}\`)`;
      }
      const result = await probeHttpServer(s);
      if (result.ok) {
        // Tool count is the honest signal — a server returning ~2 tools
        // is almost certainly bootstrap-only (auth tools), and the user
        // can run `/mcp auth <name>` to expand the toolset.
        return `- **${s.name}** (${s.type}: ${s.url}) — ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}`;
      }
      const hint =
        result.reason === "unauthorized"
          ? ` — run \`/mcp auth ${s.name}\``
          : "";
      return `- **${s.name}** (${s.type}: ${s.url}) — connection failed: ${result.message}${hint}`;
    }),
  );
  await emitAgentText(
    deps.conn,
    sessionId,
    `**MCP servers** (${servers.length})\n\n${lines.join("\n")}`,
  );
  return END_TURN;
};

const runMcpAuth = async (
  deps: CommandDeps,
  sessionId: string,
  name: string,
) => {
  if (!name) {
    await emitAgentText(
      deps.conn,
      sessionId,
      "Usage: `/mcp auth <server-name>`\nUse `/mcp list` to see configured servers.",
    );
    return END_TURN;
  }
  const session = deps.core.getSession(sessionId);
  if (!session) {
    await emitAgentText(deps.conn, sessionId, "Session not found.");
    return END_TURN;
  }
  const servers = session.clientMcpServers ?? [];
  await emitAgentText(
    deps.conn,
    sessionId,
    `Starting OAuth flow for **${name}** — your browser should open shortly. Approve the request and return here; the next prompt will pick up the authenticated tools.`,
  );
  const result = await authenticateServer(servers, name);
  if (!result.ok) {
    await emitAgentText(
      deps.conn,
      sessionId,
      `OAuth flow for **${name}** failed: ${result.error}`,
    );
    return END_TURN;
  }
  // Replace the session's MCP server list with the bearer-injected version.
  // Each `query()` is a fresh SDK session, so the next prompt naturally
  // picks up the new server list with no rotation flag needed.
  session.clientMcpServers = result.servers;
  await emitAgentText(
    deps.conn,
    sessionId,
    `**${name}** authenticated. Tools will become visible on your next prompt.`,
  );
  return END_TURN;
};

const runMemorySearch = async (
  deps: CommandDeps,
  sessionId: string,
  query: string,
) => {
  if (!query) {
    await emitAgentText(
      deps.conn,
      sessionId,
      "Usage: `/memory search <query>`",
    );
    return END_TURN;
  }
  const results = deps.memoryStore.searchMemories(query);
  if (results.length === 0) {
    await emitAgentText(
      deps.conn,
      sessionId,
      `No memories found for "${query}".`,
    );
    return END_TURN;
  }
  const lines = results.map((m) => `[#${m.id}] ${m.content}`).join("\n");
  await emitAgentText(
    deps.conn,
    sessionId,
    `**Memory search**: "${query}"\n\n${lines}`,
  );
  return END_TURN;
};

const runMemoryList = async (deps: CommandDeps, sessionId: string) => {
  const memories = deps.memoryStore.getMemories();
  if (memories.length === 0) {
    await emitAgentText(deps.conn, sessionId, "No memories stored.");
    return END_TURN;
  }
  const lines = memories.map((m) => `[#${m.id}] ${m.content}`).join("\n");
  await emitAgentText(
    deps.conn,
    sessionId,
    `**Memories** (${memories.length})\n\n${lines}`,
  );
  return END_TURN;
};

const runMemoryStore = async (
  deps: CommandDeps,
  sessionId: string,
  fact: string,
) => {
  if (!fact) {
    await emitAgentText(deps.conn, sessionId, "Usage: `/memory store <fact>`");
    return END_TURN;
  }
  const entry = deps.memoryStore.addMemory(fact);
  await emitAgentText(
    deps.conn,
    sessionId,
    `Memory stored [#${entry.id}]: "${entry.content}"`,
  );
  return END_TURN;
};

const runMemoryDelete = async (
  deps: CommandDeps,
  sessionId: string,
  rawId: string,
) => {
  const id = parseInt(rawId, 10);
  if (Number.isNaN(id)) {
    await emitAgentText(
      deps.conn,
      sessionId,
      "Usage: `/memory delete <id>`\nID must be a number.",
    );
    return END_TURN;
  }
  const deleted = deps.memoryStore.deleteMemory(id);
  await emitAgentText(
    deps.conn,
    sessionId,
    deleted ? `Memory #${id} deleted.` : `Memory #${id} not found.`,
  );
  return END_TURN;
};

const runRulesGenerate = async (deps: CommandDeps, sessionId: string) => {
  const session = deps.core.getSession(sessionId);
  if (!session) {
    await emitAgentText(deps.conn, sessionId, "Session not found.");
    return END_TURN;
  }

  const rulesDir = path.join(session.projectPath, ".claude/rules");
  const orphaned = await findOrphanedRuleBodies(rulesDir);

  if (orphaned.length === 0) {
    await emitAgentText(
      deps.conn,
      sessionId,
      "All rule bodies under `.claude/rules/` already have paired `.enforce.toml` files. Nothing to generate.",
    );
    return END_TURN;
  }

  // Status line so the user sees we're working before model output streams.
  // The synthetic prompt itself is invisible to them — only the model's
  // response (file writes via tool calls, summary at the end) is visible.
  await emitAgentText(
    deps.conn,
    sessionId,
    `Found ${orphaned.length} rule${orphaned.length === 1 ? "" : "s"} without enforcement. Asking the model to read each and generate \`.enforce.toml\` files where warranted.\n\n`,
  );

  // Dispatch via the normal prompt path so the model gets full tool
  // access (Read, Write, Edit) and the session transcript captures the
  // generation as a regular assistant turn. Returning the prompt's
  // response shape keeps the slash-command contract identical to the
  // other handlers.
  const syntheticPrompt = buildRulesGeneratePrompt(orphaned);
  return deps.core.prompt(sessionId, syntheticPrompt, deps.conn);
};

export const handleCommand = async (
  deps: CommandDeps,
  sessionId: string,
  cmd: ParsedCommand,
) => {
  switch (cmd.type) {
    case "model":
      return runModel(deps, sessionId, cmd.modelId);
    case "mode":
      return runMode(deps, sessionId, cmd.modeId);
    case "compact":
      return runCompact(deps, sessionId);
    case "memory_search":
      return runMemorySearch(deps, sessionId, cmd.query);
    case "memory_list":
      return runMemoryList(deps, sessionId);
    case "memory_store":
      return runMemoryStore(deps, sessionId, cmd.fact);
    case "memory_delete":
      return runMemoryDelete(deps, sessionId, cmd.id);
    case "mcp_list":
      return runMcpList(deps, sessionId);
    case "mcp_reload":
      return runMcpReload(deps, sessionId);
    case "mcp_auth":
      return runMcpAuth(deps, sessionId, cmd.name);
    case "rules_generate":
      return runRulesGenerate(deps, sessionId);
    case "hygiene":
      return runHygiene(deps, sessionId, cmd);
  }
};
