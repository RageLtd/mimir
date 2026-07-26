---
paths: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mts", "*.mjs", "*.rs", "*.go"]
tools: ["Edit", "Write", "MultiEdit"]
---
# Functional Style (CRITICAL)

No classes in TypeScript/JavaScript. Use plain objects, closures, and module-level functions.

- **Rust**: Data structs + trait impls. Use enums for variants. No OOP inheritance patterns.
- **Go**: Plain structs + interface satisfaction. No embedded struct hierarchies for polymorphism.

No inheritance or mutable shared state without explicit approval.
