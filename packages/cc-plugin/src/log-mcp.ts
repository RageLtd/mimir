/**
 * Re-export shim — the mimir-logs stdio MCP server moved to plugin-core
 * (@mimir/plugin-core/mcp/logs-server) when codex-plugin became its
 * second consumer (it now also serves read_codex_plugin_logs).
 */

export { runLogMcp } from "@mimir/plugin-core/mcp/logs-server";
