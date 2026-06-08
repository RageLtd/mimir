/**
 * Exhaustiveness guard for closed-union dispatch.
 *
 * Call it in the `default` arm of a switch over a discriminated union: because
 * the parameter is typed `never`, the compiler rejects the call the moment a
 * variant reaches it unhandled, failing the build instead of silently falling
 * through.
 *
 * The `: never` return annotation is REQUIRED and is the deliberate exception to
 * the no-explicit-return-types rule: TypeScript infers `void` (not `never`) for
 * a throw-only function *declaration*, which would defeat the guard's purpose
 * and pollute every `default: return assertNever(x)` call site with `void`. The
 * annotation declares the contract inference cannot produce — it hides no
 * mismatch (the body only throws).
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}
