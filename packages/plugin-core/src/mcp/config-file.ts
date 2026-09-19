/**
 * `mcpServers` config-file shape — the convention shared by Claude Code's
 * `.mcp.json`, `~/.mimir/mcp.json`, and the `[mcp.servers.<name>]` tables
 * in `mimir.toml`:
 *
 *   { "mcpServers": {
 *       "<name>": { "command": "…", "args": […], "env": {…} },      // stdio
 *       "<name>": { "type": "http", "url": "…", "headers": {…} },
 *       "<name>": { "enabled": false }                              // tombstone
 *   } }
 *
 * `enabled: false` is a tombstone: a deeper layer uses it to remove a server
 * a shallower layer defined. Validation narrows with `as<T>` helpers that
 * return `T | null`; invalid entries are reported by name, never thrown, so
 * a typo in one server does not take the rest down.
 */

import { attemptSync, type Result } from "../result";
import { asRecord } from "../toml";

export type McpStdioServer = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};
export type McpRemoteServer = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};
export type McpServerEntry = McpStdioServer | McpRemoteServer;

/** `null` is the tombstone: the server is disabled from this layer down. */
export type McpServerMap = Record<string, McpServerEntry | null>;

export type McpParseResult = { servers: McpServerMap; errors: string[] };

const asStringArray = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;

const asStringRecord = (value: unknown) => {
  const record = asRecord(value);
  return record !== null &&
    Object.values(record).every((item) => typeof item === "string")
    ? (record as Record<string, string>)
    : null;
};

type EntryResult = Result<McpServerEntry | null>;

const problem = (message: string) => [new Error(message), null] as EntryResult;
const found = (server: McpServerEntry | null) => [null, server] as EntryResult;

const parseEntry = (name: string, raw: unknown) => {
  const entry = asRecord(raw);
  if (entry === null) {
    return problem(`${name}: expected a table`);
  }
  if (entry.enabled === false) {
    return found(null);
  }
  const { type, command, args, env, url, headers } = entry;
  if (type === "http") {
    if (typeof url !== "string" || url === "") {
      return problem(`${name}: http server needs a url`);
    }
    const parsedHeaders =
      headers === undefined ? undefined : asStringRecord(headers);
    if (parsedHeaders === null) {
      return problem(`${name}: headers must be a string map`);
    }
    const server: McpRemoteServer = { type: "http", url };
    if (parsedHeaders !== undefined) {
      server.headers = parsedHeaders;
    }
    return found(server);
  }
  if (type !== undefined && type !== "stdio") {
    return problem(`${name}: unknown type ${String(type)}`);
  }
  if (typeof command !== "string" || command === "") {
    return problem(`${name}: stdio server needs a command`);
  }
  const parsedArgs = args === undefined ? undefined : asStringArray(args);
  if (parsedArgs === null) {
    return problem(`${name}: args must be a string array`);
  }
  const parsedEnv = env === undefined ? undefined : asStringRecord(env);
  if (parsedEnv === null) {
    return problem(`${name}: env must be a string map`);
  }
  const server: McpStdioServer = { command };
  if (parsedArgs !== undefined) {
    server.args = parsedArgs;
  }
  if (parsedEnv !== undefined) {
    server.env = parsedEnv;
  }
  return found(server);
};

/** Validate a `mcpServers` table (already extracted from its document). */
export const parseMcpServers = (raw: unknown) => {
  const table = asRecord(raw);
  if (raw !== undefined && table === null) {
    return { servers: {}, errors: ["mcpServers: expected a table"] };
  }
  const servers: McpServerMap = {};
  const errors: string[] = [];
  for (const [name, value] of Object.entries(table ?? {})) {
    const [error, server] = parseEntry(name, value);
    if (error !== null) {
      errors.push(error.message);
    } else {
      servers[name] = server;
    }
  }
  return { servers, errors };
};

/** Parse a `.mcp.json`-shaped document. */
export const parseMcpJson = (text: string) => {
  const [error, document] = attemptSync(() => asRecord(JSON.parse(text)));
  if (error !== null) {
    return { servers: {}, errors: [`invalid JSON: ${error.message}`] };
  }
  if (document === null) {
    return { servers: {}, errors: ["expected a JSON object"] };
  }
  return parseMcpServers(document.mcpServers);
};

/** Deeper layer wins per name; tombstones carry forward. */
export const mergeMcpServers = (base: McpServerMap, over: McpServerMap) => ({
  ...base,
  ...over,
});

/** Drop tombstones, leaving only servers to connect. */
export const enabledMcpServers = (servers: McpServerMap) =>
  Object.fromEntries(
    Object.entries(servers).filter(
      (entry): entry is [string, McpServerEntry] => entry[1] !== null,
    ),
  );
