/** Extract a human-readable message from an unknown thrown value. */
export const errMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * Parse JSON with a typed return.
 *
 * This is the single boundary where untyped JSON enters the type system.
 * The caller is responsible for ensuring the shape matches T — this is
 * inherent to JSON.parse and unavoidable without a runtime schema validator.
 */
export function parseJSON<T>(text: string): T {
  return JSON.parse(text);
}
