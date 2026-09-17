/**
 * Layered `mimir.toml` — developer-authored preferences, read at three
 * levels and merged with the deepest file winning:
 *
 *   ~/.mimir/mimir.toml            user   (per-role models, personal defaults)
 *   <project>/mimir.toml           project
 *   <project>/…/<package>/mimir.toml  nested packages in a monorepo
 *
 * Tables merge key-by-key, so a package can override `[verify].test`
 * without restating `[verify].check`. Scalars and arrays replace.
 *
 * Distinct from `~/.mimir/config.json`, which the installer writes
 * (server URL, binary paths, credentials). That file is machine state;
 * this one is intent, and it's meant to be committed.
 */

import { join, relative, resolve, sep } from "node:path";
import { createLoggerFactory } from "./logger";
import { asRecord, parseToml } from "./toml";
import { errMessage, mimirHome } from "./util";

const log = createLoggerFactory("mimir-plugin").createLogger("mimir-toml");

export const MIMIR_TOML = "mimir.toml";

const userConfigPath = () => join(mimirHome(), MIMIR_TOML);

/**
 * Config file paths from the user level down to `dir`, shallowest
 * first. `dir` at or above `projectRoot` yields user + project only.
 */
export const configLayerPaths = (dir: string, projectRoot: string) => {
  const top = resolve(projectRoot);
  const paths = [userConfigPath(), join(top, MIMIR_TOML)];
  const rel = relative(top, resolve(dir));
  if (rel === "" || rel.startsWith("..")) return paths;
  let current = top;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    paths.push(join(current, MIMIR_TOML));
  }
  return paths;
};

const readLayer = async (filePath: string) => {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  const text = await file.text().then(
    (t) => t,
    (err) => {
      log.warn("failed to read", { filePath, error: errMessage(err) });
      return null;
    },
  );
  if (text === null) return null;
  const [parseErr, parsed] = parseToml(text);
  if (parseErr) {
    log.warn("malformed mimir.toml — layer ignored", {
      filePath,
      error: errMessage(parseErr),
    });
    return null;
  }
  return parsed;
};

/** Recursive table merge; `over` wins on scalars and arrays. */
export const mergeConfig = (
  base: Record<string, unknown>,
  over: Record<string, unknown>,
) => {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const baseTable = asRecord(merged[key]);
    const overTable = asRecord(value);
    merged[key] =
      baseTable && overTable ? mergeConfig(baseTable, overTable) : value;
  }
  return merged;
};

/**
 * The merged config in effect for `dir`. Missing layers are skipped;
 * malformed layers are logged and skipped. Always returns a record —
 * an empty one when nothing is configured anywhere.
 */
export const loadMimirConfig = async (dir: string, projectRoot = dir) => {
  let merged: Record<string, unknown> = {};
  for (const filePath of configLayerPaths(dir, projectRoot)) {
    const layer = await readLayer(filePath);
    if (layer) merged = mergeConfig(merged, layer);
  }
  return merged;
};

/** True when `dir` itself holds a `mimir.toml`. */
export const hasMimirToml = (dir: string) =>
  Bun.file(join(dir, MIMIR_TOML)).exists();
