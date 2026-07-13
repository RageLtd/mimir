/**
 * Persistent project path → UUID cache.
 *
 * Hooks are short-lived processes (fresh interpreter per invocation), so
 * any in-memory cache is useless across calls. Mapping is stable —
 * git remotes don't move and project paths rarely do — which makes a disk
 * cache the right shape: warm it once on the first hook of a session,
 * skip the resolver HTTP call for every subsequent hook.
 *
 * Lives at `~/.mimir/project-paths.json`, the same `~/.mimir/` convention
 * the rest of the runtime uses for state. Corrupt / missing file returns
 * an empty map — the caller re-resolves and writes a fresh entry, which
 * heals the cache.
 *
 * Concurrency is intentionally trivial: two hooks racing on `writeCache`
 * may cost one entry, but the next hook re-resolves and re-caches. Atomic
 * write via tmp + rename is a follow-up if the race ever bites.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { attempt } from "@mimir/plugin-core/result";
import { mimirHome } from "@mimir/plugin-core/util";

export type ProjectPathCache = Record<string, string>;
export type ProjectIdAliases = Record<string, string>;

const cachePath = () => join(mimirHome(), "project-paths.json");
const aliasesPath = () => join(mimirHome(), "project-id-aliases.json");

const readMap = async (path: string) => {
  const file = Bun.file(path);
  if (!(await file.exists())) return {} as Record<string, string>;
  const [err, parsed] = await attempt(
    async () => (await file.json()) as Record<string, string>,
  );
  if (err || !parsed || typeof parsed !== "object") {
    return {} as Record<string, string>;
  }
  return parsed;
};

export const readCache = async () => readMap(cachePath());

export const readProjectIdAliases = async () => readMap(aliasesPath());

export const writeCache = async (cache: ProjectPathCache) => {
  const path = cachePath();
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  await Bun.write(path, `${JSON.stringify(cache, null, 2)}\n`);
};

export const getCachedProjectId = async (projectPath: string) => {
  const cache = await readCache();
  const value = cache[projectPath];
  return typeof value === "string" && value.length > 0 ? value : null;
};

export const setCachedProjectId = async (
  projectPath: string,
  projectId: string,
) => {
  const cache = await readCache();
  cache[projectPath] = projectId;
  await writeCache(cache);
};

export const setProjectIdAlias = async (
  legacyId: string,
  currentId: string,
) => {
  if (!legacyId || legacyId === currentId) return;
  const aliases = await readProjectIdAliases();
  aliases[legacyId] = currentId;
  const path = aliasesPath();
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  await Bun.write(path, `${JSON.stringify(aliases, null, 2)}\n`);
};
