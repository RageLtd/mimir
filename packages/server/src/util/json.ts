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

/**
 * Coerce a tool-call input to a plain object — the ONE tool-input
 * normalizer. Inputs arrive as JSON strings (wire format, old DB rows),
 * parsed objects (AI SDK parts, new DB rows), or null/undefined.
 * Providers require a plain object — not a string, not an array, not
 * null — so anything unparseable or non-object collapses to `{}`.
 */
export function parseToolInput(raw: unknown) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  const parsed = safeParseJSON(raw);
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }
  return {};
}
