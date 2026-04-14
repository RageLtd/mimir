/**
 * Claude Code backend — public surface.
 *
 * Re-exports everything callers need. The internal split across
 * mcp-config / protocol / formatting / runner / adapter is an
 * implementation detail; external code imports from this barrel.
 */

export { writeMcpConfig } from "./mcp-config";
export { iterateNdjson } from "./protocol";
export { formatContextForPrompt, buildArgs } from "./formatting";
export type { RunClaudeCodeOptions } from "./formatting";
export { runClaudeCode } from "./runner";
export { createClaudeCodeBackend } from "./adapter";
export type { ClaudeCodeBackendDeps } from "./adapter";
export { contextWithoutCurrentTurn, promptViaClaudeCode } from "./prompt-cc";
