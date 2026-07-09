# @mimir/plugin-core

Backend-agnostic shared layer for Mimir's editor adapters — the code that's
the same whether the host is Claude Code, the ACP protocol, or OpenCode.

Consumers: `@mimir/cc-plugin`, `@mimir/acp`, and `@mimir/oc-plugin`.

What lives here:

- `brain/` — the local memory brain: extraction, retrieval (hybrid FTS +
  vector), summarization, hygiene, local embeddings + embedder install
- `engine/` — local inference: provider registry (models.dev + BYOK env
  keys + local endpoints), turn streaming, secret redaction
- `keys/` — E2E key material: X25519/HKDF/AES-GCM primitives, keysets,
  org keyrings, the OS-keychain device secret, ceremony flows + CLI
- `sync/` — the one crypto seam: envelope seal/open, the sync engine
  (pull → apply → push, LWW), CLI
- `store/` — SQLite stores: org replica, user memories, cartographer index
- `tools/` — org-memory, user-memory, and cartographer tool definitions
- `cartographer/` — tree-sitter parse client, index sync, file context
- `rules/`, `project/` — rule engine and project resolution
- `markdown-to-xml.ts`, `voice-anchor.ts`, `logger.ts`, `result.ts`, `util.ts`

The only runtime dependencies are the AI SDK provider packages the
inference engine needs. Everything else is `bun:sqlite`, `node:crypto`,
`node:fs`, and the standard library. Consumers bring their own protocol
adapters, install flows, and persistence.

Submodule paths are the public API — import from
`@mimir/plugin-core/<module>`, not from the barrel. The barrel at
`src/index.ts` re-exports for callers that want a single line, but explicit
paths make the dependency graph readable.
