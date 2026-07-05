/**
 * Race a promise against a deadline. Rejects with a labelled Error when the
 * deadline wins, so the failure names WHAT hung and for how long instead of
 * stalling silently.
 *
 * The losing promise is not cancelled — JS offers no generic cancellation —
 * it is merely abandoned. Callers own any cleanup of the abandoned work
 * (e.g. closing a connection that eventually succeeds after the race).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
