/**
 * Secret value-scrubbing (MIM-73, relocated by MIM-89).
 *
 * A provider SDK error can echo the request's Authorization header
 * mid-string; every error message leaving the engine on a keyed request
 * passes through this first. The server's pino path-based redaction
 * (REDACT_PATHS) stays server-side — this is the value layer both sides
 * share.
 */

export const REDACT_CENSOR = "[redacted]";

export const redactSecret = (text: string, secret: string | undefined) =>
  secret ? text.replaceAll(secret, REDACT_CENSOR) : text;
