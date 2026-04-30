/**
 * `.mcp.json` reader.
 *
 * Reads project-local `<projectPath>/.mcp.json` and global `~/.mimir/mcp.json`
 * (or `$MIMIR_MCP_CONFIG`), validates the entries, and converts them to ACP
 * `McpServer[]` shape so they can be merged with the client-supplied list
 * from `session/new`. The file format follows the convention used by
 * Claude Code, FastMCP, VS Code, and others:
 *
 *   {
 *     "mcpServers": {
 *       "<name>": {
 *         "command": "string",   // stdio shape
 *         "args": ["string"],
 *         "env": { "KEY": "VAL" }
 *       },
 *       "<other>": {
 *         "type": "http" | "sse", // remote shape
 *         "url": "string",
 *         "headers": { "Authorization": "Bearer ..." }
 *       }
 *     }
 *   }
 *
 * Validation is hand-rolled with `as<T>` helpers that return `T | null` so
 * TypeScript narrows from inference, no predicates needed. Invalid entries
 * are skipped and logged, never thrown — `.mcp.json` errors do not block
 * session start.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { createChildLogger, log } from "../utils/log";

const logger = createChildLogger(log, "mcp-config");

const PROJECT_FILE = ".mcp.json";
const GLOBAL_FILE = "mcp.json";

const expandHome = (p: string) =>
  p.startsWith("~/") ? `${Bun.env.HOME}/${p.slice(2)}` : p;

const globalConfigPath = () =>
  Bun.env.MIMIR_MCP_CONFIG
    ? expandHome(Bun.env.MIMIR_MCP_CONFIG)
    : `${Bun.env.HOME}/.mimir/${GLOBAL_FILE}`;

const asPlainObject = (v: unknown) =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

const asStringArray = (v: unknown) =>
  Array.isArray(v) && v.every((x) => typeof x === "string")
    ? (v as string[])
    : null;

const asStringRecord = (v: unknown) => {
  const obj = asPlainObject(v);
  if (!obj) return null;
  return Object.values(obj).every((x) => typeof x === "string")
    ? (obj as Record<string, string>)
    : null;
};

/**
 * Convert a `Record<string, string>` (the shape used in `.mcp.json` for env
 * and headers) to the ACP `{ name, value }[]` shape.
 */
const recordToPairs = (rec: Record<string, string>) =>
  Object.entries(rec).map(([name, value]) => ({ name, value }));

/**
 * Validate and convert a single entry. Returns null when the entry is
 * malformed; logs the reason at warn level so misconfigurations surface.
 */
const entryToServer = (name: string, raw: unknown, source: string) => {
  const obj = asPlainObject(raw);
  if (!obj) {
    logger.warn("%s: server %s is not an object — skipping", source, name);
    return null;
  }

  // Stdio shape: has `command`.
  if (typeof obj.command === "string") {
    const args = obj.args === undefined ? [] : asStringArray(obj.args);
    if (args === null) {
      logger.warn(
        "%s: server %s has invalid args (expected string[]) — skipping",
        source,
        name,
      );
      return null;
    }
    const env = obj.env === undefined ? {} : asStringRecord(obj.env);
    if (env === null) {
      logger.warn(
        "%s: server %s has invalid env (expected Record<string,string>) — skipping",
        source,
        name,
      );
      return null;
    }
    return {
      name,
      command: obj.command,
      args,
      env: recordToPairs(env),
    };
  }

  // Remote shape: has `url`.
  if (typeof obj.url === "string") {
    const headers =
      obj.headers === undefined ? {} : asStringRecord(obj.headers);
    if (headers === null) {
      logger.warn(
        "%s: server %s has invalid headers (expected Record<string,string>) — skipping",
        source,
        name,
      );
      return null;
    }
    const headerPairs = recordToPairs(headers);
    // `as const` pins the literal so TypeScript infers
    // `type: "http" | "sse"` rather than widening to `string` across
    // the function's union of return shapes.
    if (obj.type === "sse") {
      return {
        type: "sse" as const,
        name,
        url: obj.url,
        headers: headerPairs,
      };
    }
    return {
      type: "http" as const,
      name,
      url: obj.url,
      headers: headerPairs,
    };
  }

  logger.warn(
    "%s: server %s has neither `command` nor `url` — skipping",
    source,
    name,
  );
  return null;
};

/**
 * Read a single `.mcp.json` file and return its servers. Missing files
 * yield an empty list; malformed files yield an empty list with a warning.
 *
 * Uses `Bun.file().json()` which returns a Promise that rejects on parse
 * failure, so the Result-shape comes from `.then(ok, err)` rather than
 * a try/catch around `JSON.parse`.
 */
const readFile = async (path: string) => {
  const file = Bun.file(path);
  if (!(await file.exists())) return [] as acp.McpServer[];

  const parsed = await file.json().then(
    (value: unknown) => ({ ok: true as const, value }),
    (error: unknown) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  if (!parsed.ok) {
    logger.warn("%s: invalid JSON — %s", path, parsed.error);
    return [] as acp.McpServer[];
  }

  const top = asPlainObject(parsed.value);
  if (!top) {
    logger.warn("%s: top-level value is not an object — skipping", path);
    return [] as acp.McpServer[];
  }

  if (top.mcpServers === undefined) {
    logger.debug("%s: no mcpServers key — skipping", path);
    return [] as acp.McpServer[];
  }

  const block = asPlainObject(top.mcpServers);
  if (!block) {
    logger.warn("%s: mcpServers is not an object — skipping", path);
    return [] as acp.McpServer[];
  }

  const servers: acp.McpServer[] = [];
  for (const [name, entry] of Object.entries(block)) {
    const server = entryToServer(name, entry, path);
    if (server) servers.push(server);
  }
  return servers;
};

/**
 * Load `.mcp.json` servers from the project root and the global config.
 * Project entries win on name collision over global entries.
 *
 * Resolution order (later entries overwrite earlier ones with the same name):
 *   1. `~/.mimir/mcp.json` (or `$MIMIR_MCP_CONFIG`)
 *   2. `<projectPath>/.mcp.json`
 *
 * Reserved mimir/context7/user-memory/boot names are not filtered here —
 * `buildMcpServers` already overwrites them on collision so they always
 * win over user-supplied entries.
 */
export const loadMcpConfig = async (projectPath: string) => {
  const [globalServers, projectServers] = await Promise.all([
    readFile(globalConfigPath()),
    readFile(`${projectPath}/${PROJECT_FILE}`),
  ]);

  const merged = new Map<string, acp.McpServer>();
  for (const s of globalServers) merged.set(s.name, s);
  for (const s of projectServers) merged.set(s.name, s);

  const result = [...merged.values()];
  if (result.length > 0) {
    logger.info(
      "loaded %d server(s) from .mcp.json (%d global, %d project)",
      result.length,
      globalServers.length,
      projectServers.length,
    );
  }
  return result;
};

/**
 * Merge `.mcp.json`-loaded servers with the client-supplied list from
 * `session/new`. Client-supplied entries win on name collision so a Zed-
 * configured server overrides a same-named entry in `.mcp.json`.
 */
export const mergeMcpServers = (
  fileServers: readonly acp.McpServer[],
  clientServers: readonly acp.McpServer[] | undefined,
) => {
  const merged = new Map<string, acp.McpServer>();
  for (const s of fileServers) merged.set(s.name, s);
  for (const s of clientServers ?? []) merged.set(s.name, s);
  return [...merged.values()];
};
