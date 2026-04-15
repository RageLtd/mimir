/**
 * Copilot backend — public surface.
 *
 * Re-exports everything callers need. Same barrel pattern as the
 * claude-code backend.
 */

export type { CopilotBackendDeps } from "./adapter";
export { createCopilotBackend } from "./adapter";
export type { CopilotSessionOptions, RunCopilotOptions } from "./formatting";
export {
  buildCopilotSessionOptions,
  formatContextForPrompt,
} from "./formatting";
export { buildCopilotMcpServers } from "./mcp-config";
export { runCopilot } from "./runner";
