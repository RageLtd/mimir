/**
 * Claude Code backend — public surface.
 *
 * Re-exports everything callers need. The internal split across
 * mcp-config / protocol / formatting / runner / adapter is an
 * implementation detail; external code imports from this barrel.
 */

export type { ClaudeCodeBackendDeps } from "./adapter";
export { createClaudeCodeBackend } from "./adapter";
export type { RunClaudeCodeOptions } from "./formatting";
export { buildArgs, formatContextForPrompt } from "./formatting";
export { writeMcpConfig } from "./mcp-config";
export { contextWithoutCurrentTurn, promptViaClaudeCode } from "./prompt-cc";
export { iterateNdjson } from "./protocol";
export { runClaudeCode } from "./runner";
