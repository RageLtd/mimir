# @mimir/plugin-core

Backend-agnostic shared layer for Mimir's editor adapters. The code that's
the same whether the host is Claude Code, the ACP protocol, or OpenCode.

Consumers: `@mimir/cc-plugin`, `@mimir/acp`, and the future `@mimir/oc-plugin`.

What lives here:

- `util.ts` — `errMessage`, `parseJSON`, `mimirHome`
- `result.ts` — Go-style `Result<T>` and `attempt()` helper
- (more to come: rules engine, user-memory store, cartographer client, project resolver, etc.)

The package has zero runtime dependencies. Everything is over `bun:sqlite`,
`node:fs`, and the standard library. Consumers bring their own protocol
adapters, install flows, and persistence.

Submodule paths are the public API — import from
`@mimir/plugin-core/<module>`, not from the barrel. The barrel at
`src/index.ts` re-exports for callers that want a single line, but explicit
paths make the dependency graph readable.
