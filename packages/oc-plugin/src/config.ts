/**
 * Re-export shim — the shared runtime config lives in plugin-core
 * (@mimir/plugin-core/shared-config), which owns the full
 * `~/.mimir/config.json` schema for every distribution (MIM-87 rule: shared
 * logic ships once). Kept so every oc-plugin module's `./config` import keeps
 * working unchanged.
 */

export {
  authHeaders,
  extractionConfig,
  type MimirConfig,
  providerByok,
  readConfig,
  writeConfig,
} from "@mimir/plugin-core/shared-config";
