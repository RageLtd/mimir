---
globs: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mts", "*.mjs", "*.rs", "*.go"]
tools: ["Edit", "Write", "MultiEdit"]
---
# Error Handling

Propagate errors explicitly. Do not catch and silence errors.

- **TypeScript/JavaScript**: Return `{ data, error }` result objects. Do not use try/catch for control flow.
- **Rust**: Return `Result<T, E>` and propagate with `?`. No `.unwrap()` outside of tests.
- **Go**: Return `(val, error)` and always check `err`. No blank `_` on error returns.
