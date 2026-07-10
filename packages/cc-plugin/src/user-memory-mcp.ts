/**
 * Re-export shim — the mimir-local stdio MCP server moved to plugin-core
 * (@mimir/plugin-core/mcp/local-tools-server) when codex-plugin became
 * its second consumer. The cc entry point keeps its historical name.
 */

export { runLocalToolsMcp as runUserMemoryMcp } from "@mimir/plugin-core/mcp/local-tools-server";
