/**
 * Top-level project resolution helper.
 *
 * One entry point hooks reach for: `getOrResolveProjectId(serverUrl, cwd, apiKey?)`.
 * Returns the canonical UUID for a given working directory, going through
 * the disk cache first and only hitting the resolver on a miss. Failures
 * (network down, git missing, cache corrupt) return null — callers fall
 * back to the existing cwd-as-project behaviour rather than aborting the
 * hook.
 *
 * Why null instead of throwing: the existing hooks all guarantee exit 0
 * regardless of internal errors. A resolver outage during, say, a flaky
 * VPN should not surface a failed PreToolUse to the model.
 *
 * `apiKey` is threaded through to the resolver rather than read here
 * — the consumer owns the config that holds the key, plugin-core stays
 * free of filesystem-path config coupling.
 */

import { getCachedProjectId, setCachedProjectId } from "./cache";
import { detectGitRemote } from "./git";
import { resolveProjectForPath } from "./resolver";

export type { ProjectPathCache } from "./cache";
export {
  getCachedProjectId,
  readCache,
  setCachedProjectId,
  writeCache,
} from "./cache";
export { detectGitRemote } from "./git";
export type { ProjectMetadata } from "./metadata";
export { collectProjectMetadata } from "./metadata";
export { toProjectRelative } from "./paths";
export type { ResolvedProject } from "./resolver";
export { patchProjectMetadata, resolveProjectForPath } from "./resolver";

export const getOrResolveProjectId = async (
  serverUrl: string,
  projectPath: string,
  apiKey?: string,
) => {
  const cached = await getCachedProjectId(projectPath).catch(() => null);
  if (cached) return cached;

  const gitRemote = await detectGitRemote(projectPath);
  const resolved = await resolveProjectForPath(
    serverUrl,
    apiKey,
    projectPath,
    gitRemote,
  );
  if (!resolved) return null;

  await setCachedProjectId(projectPath, resolved.id).catch(() => undefined);
  return resolved.id;
};
