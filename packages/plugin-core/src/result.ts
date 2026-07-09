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

/**
 * Sync counterpart — the ONE sanctioned sync throw→Result converter,
 * mirroring `packages/server/src/util/result.ts`. For boundaries where
 * the throw is genuinely synchronous and expected (JSON.parse, AEAD
 * auth failures in keys/crypto). The try/catch is this function's entire
 * job: it is the single boundary that turns throwing code into Result
 * tuples — the same role attempt()'s rejection handler plays for async.
 */
export const attemptSync = <T>(fn: () => T) => {
  try {
    return [null, fn()] as Result<T>;
  } catch (raw) {
    return [toError(raw), null] as Result<T>;
  }
};
