# @mimir/plugin-core

The backend-agnostic shared layer — the code that's the same whether the host is Claude Code, the ACP protocol, OpenCode, or the Codex CLI. Consumers: `@mimir/cc-plugin`, `@mimir/acp`, `@mimir/oc-plugin`, `@mimir/codex-plugin`.

The rule that shapes this package: **a user-facing flow never belongs to one editor.** Key ceremonies, sync, install-adjacent tooling, and the memory brain all ship here once; each distribution wires a thin argv entry. A user may not use Claude Code at all.

## Modules

| Path | What it owns |
|------|--------------|
| `brain/` | Extraction, retrieval (hybrid FTS + vector), summarization, hygiene, local embeddings + embedder install, boot context, embedding backfill |
| `engine/` | Local inference: provider registry (models.dev + BYOK env keys + local endpoints), turn streaming, secret redaction |
| `keys/` | E2E key material: X25519/HKDF/AES-GCM primitives, keysets, org keyrings, the OS-keychain device secret, ceremony flows + CLI |
| `sync/` | The one crypto seam: envelope seal/open, the sync engine (pull → apply → push, LWW), CLI |
| `store/` | SQLite stores: org replica, user memories, cartographer index |
| `tools/` | Org-memory, user-memory, and cartographer MCP tool definitions |
| `cartographer/` | Tree-sitter parse client, index sync, file context |
| `rules/`, `project/` | Rule engine and project resolution |
| `mcp/` | Stdio MCP server assembly |
| `anthropic-xml.ts`, `markdown-to-xml.ts`, `voice-anchor.ts`, `shared-config.ts`, `logger.ts`, `result.ts`, `util.ts` | Prompt conversion, persona anchoring, config resolution, and the small shared utilities |

Submodule paths are the public API — import from `@mimir/plugin-core/<module>`, not from the barrel. The barrel at `src/index.ts` re-exports for callers that want a single line, but explicit paths keep the dependency graph readable.

The only runtime dependencies are the AI SDK provider packages the inference engine needs. Everything else is `bun:sqlite`, `node:crypto`, `node:fs`, and the standard library. Consumers bring their own protocol adapters, install flows, and persistence.

## The memory brain

Distillation runs entirely on the developer's machine (MIM-86). At session idle, before compaction, and on the host's stop hook, new turns are handed to a configured extraction model and reduced to memories; the transcript never leaves the machine.

Storage is two SQLite stores with different scopes and different fates:

- **Org replica** (`~/.mimir/org-replica.db`) — project decisions, conventions, session summaries, playbooks. Synced to the org as ciphertext.
- **User memories** (`~/.mimir/user-memories.db`) — profile and freeform facts about the developer. **Never synced**, never leaves the machine.

Retrieval on each turn is a hybrid search over the replica: SQLite FTS for lexical recall, cosine similarity over local embeddings for semantic recall, then related-memory expansion and recent session summaries. Embeddings come from a pinned llama-server release and embedding model installed under `~/.mimir/embedder/` — no embedding API, no network call.

Hygiene — consolidating near-duplicates, resolving contradictions, forgetting stale facts — sweeps the same local replica on the same extraction model. It is dry-run by default and only advances the untouched-decay clock (`~/.mimir/hygiene-state.json`) on live runs. Every distribution shares that one clock deliberately: they sweep the same replica, so there must be exactly one notion of "when did we last look at this."

### Extraction configuration

Resolved by `extractionConfig()` in `shared-config.ts`. Environment always wins over `~/.mimir/config.json` so a key can rotate without a reinstall:

| Variable | Falls back to | Purpose |
|----------|---------------|---------|
| `MIMIR_EXTRACTION_BASE_URL` | `config.extractionBaseUrl` | OpenAI-compatible endpoint. A local Ollama works fine |
| `MIMIR_EXTRACTION_MODEL` | `config.extractionModel` → `MIMIR_SMALL_MODEL` → `config.smallModel` | The distillation/judgment model |
| `MIMIR_EXTRACTION_API_KEY` | `config.extractionApiKey` → `MIMIR_PROVIDER_API_KEY` → `config.providerApiKey` | Optional — keyless local endpoints need nothing |

When base URL or model can't be resolved, extraction is skipped and logged rather than failing the turn.

## Keys and sync

### The crypto seam

Encryption lives at exactly one place: `sync/envelope.ts`. Everything above it (replica, brain, tools) reads plaintext; everything below it (HTTP, server) carries opaque envelopes. The local replica is deliberately plaintext — it sits on the same disk as your source code, and encrypting it would buy nothing against an adversary who already has that disk.

Envelope format v2. Payload is AEAD ciphertext ‖ 16-byte tag, with a 12-byte nonce as its own field. The additional authenticated data binds `envelope_v ‖ suite ‖ kind ‖ key_gen ‖ version ‖ tombstone ‖ id ‖ org_id`, so a malicious server cannot transplant a ciphertext into another record, rewrite a version to win a convergence race, or forge a delete — all three fail client-side on open. Encrypted tombstones carry a tag over empty plaintext, so deletion intent is authenticated like any other record.

Two suites, one branch:

- `0x01` **AES-256-GCM** — the default. Key selected from the org keyring by generation.
- `0x00` **plaintext** — the self-hosted single-user toggle. Same seam, same wire shape, no key material.

Primitives are `node:crypto` only: X25519 ECDH → HKDF-SHA-256 → AES-256-GCM, zero dependencies. The `keys/` directory is the **only** place cipher primitives may be imported; anything else reaching for `node:crypto` ciphers is an architecture bug.

Convergence is last-write-wins on a monotonic `version`, with tombstoned deletes. The full specification, adversary model, and residual risks are in [THREAT_MODEL.md](../../THREAT_MODEL.md).

### Key hierarchy

Modelled on 1Password's shape. Each user holds an X25519 keypair. The org data key is wrapped to each member's public key — the server stores only wrapped blobs it cannot open. A **device secret**, held in the OS credential store via `Bun.secrets` (macOS Keychain Services / Linux libsecret / Windows Credential Manager), protects your local keyset.

macOS note: the keychain ACL binds to the `bun` binary, so the first access prompts once and covers every hook process; upgrading Bun re-prompts once. Headless environments without a credential daemon set `MIMIR_KEY_PASSPHRASE` to use the encrypted-file fallback at `~/.mimir/device-secret.enc`.

### Ceremonies

`keys/cli.ts` implements them once; every wrapper dispatches to it (`mimir keys …`, `mimir-opencode keys …`, `mimir-codex keys …`, `bun run packages/acp/index.ts keys …`):

| Command | What it does |
|---------|--------------|
| `keys status` | What this device holds — keypair, keyring generations, device-secret source |
| `keys setup` | First device. Generates the keypair and org key, **prints the device secret exactly once** |
| `keys adopt` | Bring a new device online using that secret |
| `keys rotate` | New org key generation. Removed members lose access to everything written after |
| `keys recovery-setup` / `recover` | Org recovery keypair, 1Password Recovery Group pattern |

The device secret is unrecoverable if lost — it is the only way onto a new device or out of a broken keychain.

### Sync

`sync/cli.ts` exposes two legs over the same engine:

- **`syncFromSharedConfig()`** — the boot/turn hook. Silent pull + push, never throws, and deliberately does **not** spawn the embedder: pulled rows stay FTS-searchable until the next manual sync vectorizes them, because a boot hook must not block on a cold llama-server.
- **`runSyncCommand()`** — the manual `mimir sync`. Full sync *including* the patient embedding backfill, and reports what happened.

Only `serverUrl` is required. Sync works without an `apiKey` — that's the ungated self-hosted mode, and it pushes plaintext envelopes. Config resolution is env-wins over `~/.mimir/config.json`, same as everywhere else.

## Shared config

`~/.mimir/config.json` is written by whichever installer ran first and **merged** by later ones, so several distributions coexist on one machine without clobbering each other. `shared-config.ts` is the single reader: `authHeaders()` for server calls, `providerByok()` for BYOK provider credentials, `extractionConfig()` for the local brain. Environment variables always win over the file.

## Development

```bash
bun install            # from the monorepo root — hoists workspace deps
bun run test:plugin-core
bun run typecheck
```

Shared dependencies come from the root `package.json` catalogs; reference them with `catalog:<name>`. Note that the Bun CLI cannot write the `catalog:` protocol, so catalog references are the one hand-edited exception to the "never edit manifests by hand" rule — established precedent, not a licence to hand-edit anything else.

`scripts/ensure-binary.sh` here is the **canonical** copy of the release-binary downloader. The cc-plugin and codex-plugin each carry a byte-identical mirror because their marketplace clones contain only that package — edit this copy, then re-copy, and the drift test will tell you if you forgot.
