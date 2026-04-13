/** Go-style error handling for async operations */
export type Result<T> = [error: Error, data: null] | [error: null, data: T];

export async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  return fn().then(
    (data) => [null, data] as Result<T>,
    (err) =>
      [err instanceof Error ? err : new Error(String(err)), null] as Result<T>,
  );
}
