---
globs: ["*.ts", "*.tsx", "*.mts", "*.mjs"]
tools: ["Edit", "Write", "MultiEdit"]
---
# No Explicit Return Type Annotations

Let TypeScript infer function return types. Do not write `: Promise<Foo>`, `: Response`, `: NewSessionResponse`, etc. on function signatures.

Explicit return annotations override inference — the compiler stops verifying that your implementation actually produces the shape you claim, and instead coerces the body to match the annotation. When the SDK or consumer expects a different shape than what your function truly returns, the annotation hides the mismatch. The compiler is happy; the runtime drops frames, the protocol parser chokes on malformed messages, and the bug surfaces as data corruption rather than a type error.

Inferred types propagate the real shape to every caller. A real mismatch becomes a compile error at the boundary where it actually matters.

## Exceptions

- `.d.ts` declaration files — annotations are the entire point.
- Function types inside interfaces or protocol type declarations describing an external contract (e.g. the ACP SDK's `Agent` interface). The annotation belongs to the contract, not to the implementation.
- Recursive functions where inference cannot converge without an annotation.

If you reach for a return annotation for "clarity" or "documentation," resist. Rename the function, extract the return value into a named variable, or improve the input types — those fix the real clarity problem without blinding the compiler.
