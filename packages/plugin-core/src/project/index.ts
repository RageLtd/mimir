/**
 * Top-level local project identity helper.
 *
 * The public signature stays compatible with installed adapters, but the
 * server URL and API key are no longer used. Identity is derived locally
 * from the normalized git remote, or the absolute path when no remote exists.
 *
 * Why null instead of throwing: the existing hooks all guarantee exit 0
 * regardless of internal errors. A resolver outage during, say, a flaky
 * VPN should not surface a failed PreToolUse to the model.
 *
 * `apiKey` is threaded through to the resolver rather than read here
 * — the consumer owns the config that holds the key, plugin-core stays
 * free of filesystem-path config coupling.
 */

import { attempt } from "../result";
import { createOrgReplica, defaultOrgReplicaPath } from "../store/org-replica";
import {
  deleteCachedProjectId,
  getCachedProjectId,
  setCachedProjectId,
  setProjectIdAlias,
} from "./cache";
import { detectGitRemote } from "./git";
import { resolveProjectForPath } from "./resolver";
import { resolveProjectRoot } from "./root";

export type { ProjectPathCache } from "./cache";
export {
  getCachedProjectId,
  readCache,
  readProjectIdAliases,
  readProjectNames,
  setCachedProjectId,
  setProjectIdAlias,
  writeCache,
} from "./cache";
export { detectGitRemote } from "./git";
export { isInsideProject, toProjectRelative } from "./paths";
export type { ResolvedProject } from "./resolver";
export { normalizeGitRemote, resolveProjectForPath } from "./resolver";
export { findGitRoot, resolveProjectRoot } from "./root";
export {
  findPackageRoot,
  type ResolvedToolchain,
  resolveToolchain,
  resolveToolchainsForFiles,
  type ToolchainSource,
  type VerifyCommands,
} from "./toolchain";

const migrateProjectId = async (legacyId: string, currentId: string) => {
  const replicaPath =
    process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath();
  const replica = createOrgReplica(replicaPath);
  const [err] = await attempt(async () =>
    replica.replaceProjectId(legacyId, currentId),
  );
  replica.close();
  if (err) throw err;
  await setProjectIdAlias(legacyId, currentId).catch(() => undefined);
};

/**
 * Identity keys on the repository root, whatever cwd the host handed the
 * hook (MIM-131): a session cwd drifts with Bash `cd`, and a path-derived
 * id that followed it would split one repo's memories across directories.
 * An id a pre-root install cached under a nested path is migrated through
 * the same alias path as a legacy server id.
 */
export const getOrResolveProjectId = async (
  serverUrl: string,
  projectPath: string,
  apiKey?: string,
) => {
  const root = await resolveProjectRoot(projectPath);
  const cached = await getCachedProjectId(root).catch(() => null);
  // A pre-root install may have cached an id under the nested cwd itself.
  // Checked before the early return so a warm root entry cannot strand it;
  // dropped once migrated so the cache holds roots only.
  const nested =
    root === projectPath
      ? null
      : await getCachedProjectId(projectPath).catch(() => null);
  if (cached?.startsWith("project:") && nested === null) return cached;

  const gitRemote = await detectGitRemote(root);
  const resolved = await resolveProjectForPath(
    serverUrl,
    apiKey,
    root,
    gitRemote,
  );
  for (const legacy of [cached, nested]) {
    if (legacy && legacy !== resolved.id) {
      await migrateProjectId(legacy, resolved.id);
    }
  }

  if (nested !== null) {
    await deleteCachedProjectId(projectPath).catch(() => undefined);
  }
  await setCachedProjectId(root, resolved.id).catch(() => undefined);
  return resolved.id;
};
