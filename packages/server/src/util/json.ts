/**
 * Minimal JSON utilities — parse with fallback.
 */

import { log } from "./logger";

/**
 * Best-effort JSON parse. Returns the parsed value on success, the raw
 * string on failure so callers can propagate malformed payloads without
 * crashing. Logs failures at debug level.
 *
 * The try/catch wraps `JSON.parse` (sync stdlib that throws — no
 * `.catch` chain available). The external contract is a value, not an
 * exception.
 */
export function safeParseJSON(str: string) {
  try {
    return JSON.parse(str);
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "safeParseJSON failed, returning raw string",
    );
    return str;
  }
}
