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

import { createOrgReplica, defaultOrgReplicaPath } from "../store/org-replica";
import {
  getCachedProjectId,
  setCachedProjectId,
  setProjectIdAlias,
} from "./cache";
import { detectGitRemote } from "./git";
import { resolveProjectForPath } from "./resolver";

export type { ProjectPathCache } from "./cache";
export {
  getCachedProjectId,
  readCache,
  readProjectIdAliases,
  setCachedProjectId,
  setProjectIdAlias,
  writeCache,
} from "./cache";
export { detectGitRemote } from "./git";
export { toProjectRelative } from "./paths";
export type { ResolvedProject } from "./resolver";
export { normalizeGitRemote, resolveProjectForPath } from "./resolver";

export const getOrResolveProjectId = async (
  serverUrl: string,
  projectPath: string,
  apiKey?: string,
) => {
  const cached = await getCachedProjectId(projectPath).catch(() => null);
  if (cached?.startsWith("project:")) return cached;

  const gitRemote = await detectGitRemote(projectPath);
  const resolved = await resolveProjectForPath(
    serverUrl,
    apiKey,
    projectPath,
    gitRemote,
  );
  if (cached && cached !== resolved.id) {
    const replicaPath =
      process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath();
    const replica = createOrgReplica(replicaPath);
    try {
      replica.replaceProjectId(cached, resolved.id);
    } finally {
      replica.close();
    }
    await setProjectIdAlias(cached, resolved.id).catch(() => undefined);
  }

  await setCachedProjectId(projectPath, resolved.id).catch(() => undefined);
  return resolved.id;
};
