/**
 * Effective per-role worker models for a host (MIM-41).
 *
 * Two sources, developer intent over machine state:
 *
 *   mimir.toml `[workers.models.<host>]` — layered user (~/.mimir) →
 *     project → package by `loadMimirConfig`, committable, so a repo can
 *     pin its own models (an OpenCode project on local models, say)
 *   ~/.mimir/config.json `workerModels.<host>` — the installer-written
 *     baseline
 *
 * Roles merge one at a time: a toml layer that names only `review`
 * leaves `impl` and `test` on whatever config.json says.
 */

import { loadMimirConfig } from "../mimir-toml";
import {
  readConfig,
  type WorkerHost,
  workerModelsFor,
  workerRoleModelsFrom,
} from "../shared-config";
import { asRecord } from "../toml";
import { mimirHome } from "../util";

const WORKERS_TABLE = "workers";
const MODELS_TABLE = "models";

/** The `[workers.models.<host>]` table of a merged mimir.toml config. */
export const workerModelsFromToml = (
  config: Record<string, unknown>,
  host: WorkerHost,
) => {
  const models = asRecord(asRecord(config[WORKERS_TABLE])?.[MODELS_TABLE]);
  return workerRoleModelsFrom(models?.[host]);
};

/**
 * config.json overlaid by mimir.toml. Without `projectRoot` only the user
 * layer applies — what an installer rendering global agent files wants.
 */
export const resolveWorkerModels = async (
  host: WorkerHost,
  projectRoot?: string,
) => {
  const base = workerModelsFor(await readConfig(), host);
  const root = projectRoot ?? mimirHome();
  const toml = workerModelsFromToml(await loadMimirConfig(root, root), host);
  return { ...base, ...toml };
};
