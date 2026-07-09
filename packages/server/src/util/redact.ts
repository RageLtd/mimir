/**
 * Secret redaction (MIM-73) — both layers live here, NOT in util/logger.ts,
 * because the test preload (tests/setup.ts) mocks the logger module wholesale
 * and every export added there must be mirrored in the mock (see the MIM-68
 * lockstep gotcha). This module stays real in tests.
 */

/**
 * Path-based pino redaction paths (fast-redact). Covers every shape a BYOK
 * provider key could take in a log object — kills the "someone spreads
 * ctx/override into a log call" class structurally.
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

// Value-layer scrubbing (redactSecret) lives client-side in plugin-core's
// engine — the blind server handles no provider keys and compiles without
// any plugin-core import (the Docker build ships no plugin-core source).
export const REDACT_CENSOR = "[redacted]";
