---
globs: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mts", "*.mjs", "*.rs", "*.go"]
tools: ["Edit", "Write", "MultiEdit"]
---
# Exhaustive Switch Over If-Else Chains

When dispatching on a **known, closed set of variants** — a discriminated union's `kind`/`type`/`tag`, an enum, a string-literal union — use an exhaustive `switch` (TS/JS) or `match` (Rust), not an `if`/`else if` chain.

The point is compiler-enforced totality. A `switch` over a union with a `default: assertNever(x)` arm — or a non-wildcard Rust `match` — makes the compiler fail the moment a new variant is added and a branch is missing. An `if`/`else if` chain falls through silently: the new variant lands in the trailing `else`, or nowhere, and the bug ships unnoticed.

## Wrong

```ts
if (node.kind === "literal") return evalLiteral(node);
else if (node.kind === "binary") return evalBinary(node);
else if (node.kind === "unary") return evalUnary(node);
// add a "ternary" variant later → no compile error, silently unhandled
```

## Correct

```ts
switch (node.kind) {
  case "literal": return evalLiteral(node);
  case "binary": return evalBinary(node);
  case "unary": return evalUnary(node);
  default: return assertNever(node); // compile error when a variant is unhandled
}
```

where `assertNever` is a tiny helper whose parameter is typed `never` and which throws at runtime — because the parameter is `never`, the compiler rejects the call (and fails the build) the instant a variant reaches it unhandled.

The same applies in Rust, where a `match` without a `_` wildcard gives exhaustiveness for free. Both `==`-against-enum chains and `if let` / `else if let` chains on one scrutinee are the smell:

```rust
// Wrong — adding Kind::Ternary later compiles fine, silently unhandled
if node.kind == Kind::Literal { eval_literal(node) }
else if node.kind == Kind::Binary { eval_binary(node) }
else if node.kind == Kind::Unary { eval_unary(node) }

// Correct — non-wildcard match fails to compile on a new unhandled variant
match node.kind {
    Kind::Literal => eval_literal(node),
    Kind::Binary => eval_binary(node),
    Kind::Unary => eval_unary(node),
}
```

## Stays an if-else

This rule targets *variant dispatch*, not every conditional. Keep `if`/`else` for:

- Boolean or null/undefined checks (`if (!user) return`).
- Range or threshold comparisons (`if (n < 0) … else if (n < 10) …`).
- Heterogeneous guards testing different values or side conditions in each branch.
- A single condition with one `else`.
