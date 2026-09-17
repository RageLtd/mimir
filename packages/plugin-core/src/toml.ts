/**
 * TOML parse boundary.
 *
 * `Bun.TOML.parse` returns `object` and throws `SyntaxError` on bad
 * input. This is the one place that converts the throw into a Result
 * tuple and the `object` into a record; consumers narrow fields at the
 * decision site, the same way `JSON.parse` output is treated.
 */

import { attemptSync } from "./result";

/**
 * Narrow an untyped parse result to a plain record. Arrays and
 * primitives come back null so callers can treat "not a table" and
 * "absent" the same way.
 */
export const asRecord = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Parse TOML text into a record; malformed input is an error. */
export const parseToml = (text: string) =>
  attemptSync(() => {
    const parsed = asRecord(Bun.TOML.parse(text));
    if (parsed === null) {
      throw new Error("TOML document is not a table");
    }
    return parsed;
  });
