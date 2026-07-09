/**
 * Exhaustiveness helper — the parameter is `never`, so the compiler
 * rejects the call (and fails the build) the instant a union variant
 * reaches it unhandled. Throws at runtime as a last-resort guard.
 * Mirrors the server's util/assert.ts.
 *
 * The `: never` return annotation is a documented return-types-rule
 * exception (same as the server's copy): TS infers `void`, not `never`,
 * for throwing function DECLARATIONS, which would break value-position
 * `default: return assertNever(x)` call sites. Inference cannot converge
 * on the correct type here.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}
