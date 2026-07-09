/**
 * Secret redaction (MIM-73) — both layers live here, NOT in util/logger.ts,
 * because the test preload (tests/setup.ts) mocks the logger module wholesale
 * and every export added there must be mirrored in the mock (see the MIM-68
 * lockstep gotcha). This module stays real in tests.
 */

/**
 * Path-based pino redaction paths (fast-redact). Covers every shape a BYOK
 * provider key could take in a log object — kills the "someone spreads
 * ctx/override into a log call" class structurally. Path-based only:
 * response bodies never pass through pino, hence redactSecret below.
 */
export const REDACT_PATHS = [
  "apiKey",
  "*.apiKey",
  "providerOverride.apiKey",
  "*.providerOverride.apiKey",
  'headers["x-provider-api-key"]',
  '*.headers["x-provider-api-key"]',
  // Mimir API keys ride Authorization (MIM-77) — same discipline.
  "authorization",
  "*.authorization",
  "headers.authorization",
  "*.headers.authorization",
];

// Value layer moved to the shared engine (MIM-89) — the client-side turn
// loop scrubs provider errors with the same helper. Re-exported so the
// server's response surfaces keep their import path until they die in the
// reduction slice.
export { REDACT_CENSOR, redactSecret } from "@mimir/plugin-core/engine/redact";
