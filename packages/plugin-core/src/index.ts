/**
 * Public surface of @mimir/plugin-core.
 *
 * Modules are imported by their submodule path, not this barrel — the
 * convention keeps the dependency graph explicit:
 *
 *   import { errMessage, mimirHome } from "@mimir/plugin-core/util";
 *   import { attempt } from "@mimir/plugin-core/result";
 *
 * As the shared layer grows (rules engine, user-memory store, cartographer
 * client, project resolver, etc.) each module gets its own file and is
 * imported by its specific path. The barrel re-exports the most-reached-for
 * helpers so callers that want a single import line can have one.
 */

export * from "./logger";
export * from "./result";
export * from "./util";
