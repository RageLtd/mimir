import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { attempt } from "@mimir/plugin-core/result";

/**
 * Repo-scoped addons live in `<project>/.mimir/`, laid out the way Claude
 * Code plugins are (`commands/`, `skills/`, `agents/`, `hooks/`) so the SDK
 * loads them as a local plugin. Further plugins nest under
 * `.mimir/plugins/<name>/`. MCP discovery is left to the resources layer,
 * which owns every server connection.
 */
export const MIMIR_DIR = ".mimir";
export const PLUGINS_DIR = "plugins";

export type LocalPlugin = {
  type: "local";
  path: string;
  skipMcpDiscovery: true;
};

const isDirectory = async (path: string) => {
  const [error, info] = await attempt(() => stat(path));
  return error === null && info.isDirectory();
};

const plugin = (path: string): LocalPlugin => ({
  type: "local",
  path,
  skipMcpDiscovery: true,
});

export const discoverLocalPlugins = async (projectRoot: string) => {
  const root = join(projectRoot, MIMIR_DIR);
  if (!(await isDirectory(root))) {
    return [];
  }
  const plugins = [plugin(root)];
  const nested = join(root, PLUGINS_DIR);
  if (!(await isDirectory(nested))) {
    return plugins;
  }
  const [error, entries] = await attempt(() =>
    readdir(nested, { withFileTypes: true }),
  );
  if (error !== null) {
    return plugins;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      plugins.push(plugin(join(nested, entry.name)));
    }
  }
  return plugins;
};
