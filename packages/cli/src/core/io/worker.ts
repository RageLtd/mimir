import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { enabledMcpServers } from "@mimir/plugin-core/mcp/config-file";
import { attempt, type Result } from "@mimir/plugin-core/result";
import { mimirHome } from "@mimir/plugin-core/util";
import {
  DEFAULT_CONFIG,
  parseConfig,
  stringifyConfig,
} from "../config/schema.ts";
import { parseRules, stringifyRules } from "../permissions/rules.ts";
import { loadResource } from "../resources/loader.ts";
import { mcpServersSpec } from "../resources/mcp.ts";
import { discoverLocalPlugins } from "../resources/plugins.ts";
import { findProjectRoot } from "../resources/project-root.ts";
import { assertNever } from "../result.ts";
import type { Action } from "../store/actions.ts";
import {
  CONFIG_FILE_NAME,
  type IoCommand,
  PERMISSIONS_FILE_NAME,
} from "./protocol.ts";

declare var self: Worker;

const emit = (action: Action) => self.postMessage(action);

const homePath = (fileName: string) => join(mimirHome(), fileName);

/** Missing file → `fallback`; unreadable or invalid → error. */
const loadToml = async <T>(
  fileName: string,
  parse: (text: string) => Result<T>,
  fallback: T,
) => {
  const file = Bun.file(homePath(fileName));
  if (!(await file.exists())) {
    return [null, fallback] as Result<T>;
  }
  const [readError, text] = await attempt(() => file.text());
  return readError === null ? parse(text) : ([readError, null] as Result<T>);
};

const saveToml = async (fileName: string, text: string) => {
  const path = homePath(fileName);
  return attempt(async () => {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, text);
  });
};

const loadResources = async (cwd: string) => {
  const projectRoot = await findProjectRoot(cwd);
  const [mcp, plugins] = await Promise.all([
    loadResource(mcpServersSpec({ cwd, projectRoot })),
    discoverLocalPlugins(projectRoot),
  ]);
  emit({
    type: "resources/loaded",
    projectRoot,
    mcpServers: enabledMcpServers(mcp.value),
    plugins,
    reports: mcp.reports,
  });
};

const handle = async (command: IoCommand) => {
  switch (command.type) {
    case "io/load-config": {
      const [error, config] = await loadToml(
        CONFIG_FILE_NAME,
        parseConfig,
        DEFAULT_CONFIG,
      );
      emit(
        error === null
          ? { type: "config/loaded", config }
          : { type: "config/load-failed", error: error.message },
      );
      return;
    }
    case "io/save-config": {
      const [error] = await saveToml(
        CONFIG_FILE_NAME,
        stringifyConfig(command.config),
      );
      emit(
        error === null
          ? { type: "config/saved" }
          : { type: "config/save-failed", error: error.message },
      );
      return;
    }
    case "io/load-permissions": {
      const [error, rules] = await loadToml(
        PERMISSIONS_FILE_NAME,
        parseRules,
        [],
      );
      emit(
        error === null
          ? { type: "permissions/loaded", rules }
          : { type: "permissions/load-failed", error: error.message },
      );
      return;
    }
    case "io/save-permissions": {
      const [error] = await saveToml(
        PERMISSIONS_FILE_NAME,
        stringifyRules(command.rules),
      );
      emit(
        error === null
          ? { type: "permissions/saved" }
          : { type: "permissions/save-failed", error: error.message },
      );
      return;
    }
    case "io/load-resources":
      await loadResources(command.cwd);
      return;
    default:
      assertNever(command);
  }
};

self.addEventListener("message", (event: MessageEvent<IoCommand>) => {
  void handle(event.data);
});
