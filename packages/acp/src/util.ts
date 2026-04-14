/** Extract a human-readable message from an unknown thrown value. */
export const errMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);
