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
];

export const REDACT_CENSOR = "[redacted]";

/**
 * Value scrubbing for response surfaces. A provider SDK error can echo the
 * request's Authorization header mid-string; every error message leaving
 * the server on a BYOK request passes through this first.
 */
export const redactSecret = (text: string, secret: string | undefined) =>
  secret ? text.replaceAll(secret, REDACT_CENSOR) : text;
