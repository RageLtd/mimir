/** Go-style error handling for async operations */
export type Result<T> = [error: Error, data: null] | [error: null, data: T];

export async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  return fn().then(
    (data): Result<T> => [null, data],
    (err): Result<T> => [
      err instanceof Error ? err : new Error(String(err)),
      null,
    ],
  );
}

/**
 * Go-style error handling for synchronous operations (JSON.parse and other
 * throwing serialization-boundary calls). This is the one sanctioned
 * throw→result converter for sync code — call sites stay try/catch-free.
 *
 * The return annotation is deliberate: without it the tuple literals widen
 * to `(Error | T | null)[]` and destructuring loses the invariant. Same
 * pattern as attempt() above.
 */
export function attemptSync<T>(fn: () => T): Result<T> {
  try {
    return [null, fn()];
  } catch (err) {
    return [err instanceof Error ? err : new Error(String(err)), null];
  }
}
