import type { CliConfig } from "../config/schema.ts";
import type { AllowRule } from "../permissions/rules.ts";

/**
 * Main → io worker. Replies come back as `config/*`, `permissions/*` and
 * `resources/*` actions. All files live under `mimirHome()` (`~/.mimir`,
 * or `MIMIR_HOME`) except the project-scoped resources.
 */
export type IoCommand =
  | { type: "io/load-config" }
  | { type: "io/save-config"; config: CliConfig }
  | { type: "io/load-permissions" }
  | { type: "io/save-permissions"; rules: AllowRule[] }
  | { type: "io/load-resources"; cwd: string };

export const CONFIG_FILE_NAME = "cli-config.toml";
export const PERMISSIONS_FILE_NAME = "cli-permissions.toml";
