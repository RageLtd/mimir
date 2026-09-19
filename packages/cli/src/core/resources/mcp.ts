import { join } from "node:path";
import {
  type McpServerMap,
  mergeMcpServers,
  parseMcpJson,
  parseMcpServers,
} from "@mimir/plugin-core/mcp/config-file";
import { configLayerPaths } from "@mimir/plugin-core/mimir-toml";
import { asRecord, parseToml } from "@mimir/plugin-core/toml";
import { mimirHome } from "@mimir/plugin-core/util";
import type { Layer, ResourceSpec } from "./loader.ts";

export const GLOBAL_MCP_FILE = "mcp.json";
export const MACHINE_CONFIG_FILE = "config.json";
export const PROJECT_MCP_FILE = ".mcp.json";

export type ResourceContext = { cwd: string; projectRoot: string };

/** JSON documents carry servers under a top-level `mcpServers` key. */
const fromJson = (text: string) => {
  const { servers, errors } = parseMcpJson(text);
  return { value: servers, errors };
};

/** `mimir.toml` carries them under `[mcp.servers.<name>]`. */
const fromToml = (text: string) => {
  const [error, document] = parseToml(text);
  if (error !== null) {
    return { value: {}, errors: [`malformed TOML: ${error.message}`] };
  }
  const { servers, errors } = parseMcpServers(asRecord(document.mcp)?.servers);
  return { value: servers, errors };
};

/**
 * Layer order, shallowest first: the installer-written global file, the
 * machine config, every `mimir.toml` from user level down to `cwd`, then
 * the project's own `.mcp.json`. A deeper layer overrides or tombstones a
 * server by name.
 */
export const mcpServersSpec = (
  context: ResourceContext,
): ResourceSpec<McpServerMap> => {
  const home = mimirHome();
  const layers: Layer<McpServerMap>[] = [
    { path: join(home, GLOBAL_MCP_FILE), parse: fromJson },
    { path: join(home, MACHINE_CONFIG_FILE), parse: fromJson },
    ...configLayerPaths(context.cwd, context.projectRoot).map((path) => ({
      path,
      parse: fromToml,
    })),
    { path: join(context.projectRoot, PROJECT_MCP_FILE), parse: fromJson },
  ];
  return { name: "mcp servers", layers, empty: {}, merge: mergeMcpServers };
};
