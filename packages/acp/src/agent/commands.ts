/**
 * Slash command execution.
 *
 * Parses and dispatches in-chat commands (`/model`, `/mode`, `/compact`,
 * `/memory *`) against the agent core and streams the response back to the
 * editor. Each command is a small standalone function to keep the switch
 * flat and individually reviewable.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { isValidCCMode } from "../backends/claude-code/config-options";
import type { UserMemoryStore } from "../store/user-memories";
import type { AgentCore, SessionState } from "./types";
import type { ParsedCommand } from "./session";

export type CommandDeps = {
  readonly core: AgentCore;
  readonly conn: acp.AgentSideConnection;
  readonly memoryStore: UserMemoryStore;
  readonly buildSessionConfigOptions: (
    session: SessionState,
  ) => acp.SessionConfigOption[];
};

const END_TURN: acp.PromptResponse = { stopReason: "end_turn" };

const reply = async (
  conn: acp.AgentSideConnection,
  sessionId: string,
  text: string,
) => {
  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });
};

const runModel = async (
  deps: CommandDeps,
  sessionId: string,
  modelId: string | undefined,
) => {
  if (!modelId) {
    await reply(deps.conn, sessionId, "Usage: `/model <model-id>`");
    return END_TURN;
  }
  const ok = deps.core.setModel(sessionId, modelId);
  await reply(
    deps.conn,
    sessionId,
    ok ? `Model switched to \`${modelId}\`.` : "Session not found.",
  );
  return END_TURN;
};

const listActiveModes = (
  deps: CommandDeps,
  sessionId: string,
): string => {
  const session = deps.core.getSession(sessionId);
  if (!session) return "(session not found)";
  const opt = deps.buildSessionConfigOptions(session).find(
    (o) => o.id === "mode",
  );
  if (!opt || opt.type !== "select") {
    return "(none — backend has no mode catalogue)";
  }
  return (opt.options as { value: string }[])
    .map((o) => `\`${o.value}\``)
    .join(", ");
};

const runMode = async (
  deps: CommandDeps,
  sessionId: string,
  modeId: string | undefined,
) => {
  if (!modeId) {
    const list = listActiveModes(deps, sessionId);
    await reply(
      deps.conn,
      sessionId,
      `Usage: \`/mode <id>\`\nAvailable modes: ${list}`,
    );
    return END_TURN;
  }
  if (!isValidCCMode(modeId)) {
    const list = listActiveModes(deps, sessionId);
    await reply(
      deps.conn,
      sessionId,
      `Unknown mode \`${modeId}\`. Available: ${list}`,
    );
    return END_TURN;
  }
  const ok = deps.core.setMode(sessionId, modeId);
  if (!ok) {
    await reply(deps.conn, sessionId, "Session not found.");
    return END_TURN;
  }
  await deps.conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "current_mode_update",
      currentModeId: modeId,
    },
  });
  await reply(deps.conn, sessionId, `Mode switched to **${modeId}**.`);
  return END_TURN;
};

const runCompact = async (deps: CommandDeps, sessionId: string) => {
  deps.core.compact(sessionId);
  await reply(deps.conn, sessionId, "Session history cleared.");
  return END_TURN;
};

const runMemorySearch = async (
  deps: CommandDeps,
  sessionId: string,
  query: string,
) => {
  if (!query) {
    await reply(deps.conn, sessionId, "Usage: `/memory search <query>`");
    return END_TURN;
  }
  const results = deps.memoryStore.searchMemories(query);
  if (results.length === 0) {
    await reply(deps.conn, sessionId, `No memories found for "${query}".`);
    return END_TURN;
  }
  const lines = results.map((m) => `[#${m.id}] ${m.content}`).join("\n");
  await reply(
    deps.conn,
    sessionId,
    `**Memory search**: "${query}"\n\n${lines}`,
  );
  return END_TURN;
};

const runMemoryList = async (deps: CommandDeps, sessionId: string) => {
  const memories = deps.memoryStore.getMemories();
  if (memories.length === 0) {
    await reply(deps.conn, sessionId, "No memories stored.");
    return END_TURN;
  }
  const lines = memories.map((m) => `[#${m.id}] ${m.content}`).join("\n");
  await reply(
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
    await reply(deps.conn, sessionId, "Usage: `/memory store <fact>`");
    return END_TURN;
  }
  const entry = deps.memoryStore.addMemory(fact);
  await reply(
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
    await reply(
      deps.conn,
      sessionId,
      "Usage: `/memory delete <id>`\nID must be a number.",
    );
    return END_TURN;
  }
  const deleted = deps.memoryStore.deleteMemory(id);
  await reply(
    deps.conn,
    sessionId,
    deleted ? `Memory #${id} deleted.` : `Memory #${id} not found.`,
  );
  return END_TURN;
};

export const handleCommand = async (
  deps: CommandDeps,
  sessionId: string,
  cmd: ParsedCommand,
): Promise<acp.PromptResponse> => {
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
  }
};
