/**
 * Message log module — public API.
 *
 * Re-exports everything from persistence and compaction-state submodules.
 */

export {
  type CompactionState,
  clearStaleCompaction,
  finishCompaction,
  getCompactionState,
  startCompaction,
  updateTokenCount,
} from "./compaction-state";
export {
  type MessageRow,
  modelContentToString,
  modelMessageToFields,
  rowToModelMessage,
} from "./message-utils";
export {
  appendAssistantOutput,
  appendModelMessage,
  appendTrailingTurn,
  appendTurn,
  extractTrailingTurn,
  getLastNModelMessages,
  getModelMessagesSince,
} from "./persistence";
