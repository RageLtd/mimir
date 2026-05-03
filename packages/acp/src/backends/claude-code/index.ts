/**
 * Claude Code backend — public surface.
 *
 * Re-exports everything callers need. The internal split across
 * mcp-config / formatting / runner / adapter is an implementation
 * detail; external code imports from this barrel.
 */

export type { ClaudeCodeBackendDeps } from "./adapter";
export { createClaudeCodeBackend } from "./adapter";
export type { BootContent } from "./boot-tools";
export { createBootServer } from "./boot-tools";
export type { RunClaudeCodeOptions } from "./formatting";
export { buildSdkOptions, formatContextForPrompt } from "./formatting";
export { buildMcpServers } from "./mcp-config";
export { promptViaClaudeCode } from "./prompt-cc";
export type { CcSession } from "./runner";
export { feedClaudeCodeMessage, startClaudeCodeSession } from "./runner";
