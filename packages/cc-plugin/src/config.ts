/**
 * Re-export shim — the shared runtime config moved to plugin-core
 * (@mimir/plugin-core/shared-config) when codex-plugin became its third
 * consumer (MIM-87 rule: shared logic ships once). Kept so every
 * cc-plugin module's `./config` import keeps working unchanged.
 */

export {
  authHeaders,
  extractionConfig,
  type MimirConfig,
  providerByok,
  readConfig,
  writeConfig,
} from "@mimir/plugin-core/shared-config";
