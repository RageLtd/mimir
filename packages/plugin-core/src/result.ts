/**
 * Go-style result helper — mirrors `packages/server/src/util/result.ts`
 * in the mimir monorepo so plugin and server share the same idiom.
 *
 * Wrap any async function (including async arrows around sync code that
 * may throw) and get back a tuple `[error, data]`. The throwing branch
 * never escapes; the caller handles error explicitly without try/catch.
 *
 * For genuinely-sync code that may throw (e.g. `JSON.parse`), wrap in
 * an async arrow so a synchronous throw becomes a rejected promise:
 *
 *   const [err, parsed] = await attempt(async () => JSON.parse(text));
 */

export type Result<T> =
  | readonly [error: Error, data: null]
  | readonly [error: null, data: T];

const toError = (raw: unknown) =>
  raw instanceof Error ? raw : new Error(String(raw));

export const attempt = async <T>(fn: () => Promise<T>) =>
  fn().then(
    (data) => [null, data] as Result<T>,
    (err) => [toError(err), null] as Result<T>,
  );
