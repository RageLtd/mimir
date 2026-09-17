# Mimir

Bun workspace. Coding conventions live in `.claude/rules/` and are loaded on every host Mimir runs on — Claude Code reads them natively, and the ACP, OpenCode, and Codex distributions inject them — so they are not repeated here.

<!-- CLAUDE.md is a symlink to this file: Claude Code reads CLAUDE.md, everything else reads AGENTS.md.
     On a Windows checkout without symlink support, replace CLAUDE.md with a file containing `@AGENTS.md`. -->

## Code Style

- No type casts (`as`) — if you need one, the types are wrong. The exception is serialisation boundaries (`JSON.parse`, `response.json()`, protocol fields typed as `unknown`) where TypeScript genuinely cannot know the shape without a runtime validation library. Casts at these boundaries are acceptable; casts inside the codebase are not.
- "Less code more gooder."

## Commands

- `bun run test` — all packages; `bun run test:<package>` for one (`server`, `plugin-core`, `acp`, `cc-plugin`, `oc-plugin`, `codex-plugin`).
- `bun run check` — Biome lint and format, writes fixes in place.
- `bun run typecheck` — `tsc --noEmit` per package. Neither the builds nor the tests type-check, so this is the only gate that catches type errors before release.
- `bun run acp:build`, `bun run cc-plugin:build`, `bun run codex-plugin:build` — release bundles. The two plugin builds run `./build.sh`, which ad-hoc-signs the Darwin binary; without that step the binary dies with SIGKILL.
- `bun run server:dev` — mimir-server with file watching.

Run tests through the root scripts, never `bun test <path>` from the repo root: package-level `bunfig.toml` preloads (the server's `tests/setup.ts`) only apply when Bun starts inside that package.

## Repository Layout

Bun workspace — the root `package.json` defines `workspaces` plus dependency catalogs. Six packages:

- `packages/server` — mimir-server, deliberately **blind**: auth, wrapped-key distribution (`/v1/keys`, `/v1/members`), ciphertext sync (`/v1/sync`), `/v1/system-prompt`, operator-only `/mcp` introspection, and the browser admin/operator surfaces. It runs no models and parses no memory content. Inference, extraction, hygiene, embeddings, and persistence are all client-side (MIM-86, MIM-89). `system-prompt.md` is the seed for the prompt stored in the auth database. Boot reconciles the two (`operator/state.ts` `applySystemPromptSeed`): a changed file replaces the stored copy when that copy is still the last-applied seed, so prompt edits reach clients by redeploying the file — unless an operator edited the stored prompt since, in which case the edit wins and boot logs `kept-operator-edit`.
- `packages/plugin-core` — backend-agnostic shared layer consumed by every editor adapter: brain (extraction, retrieval, summarization, hygiene, embedder), inference engine (provider registry, turn streaming), local stores (org replica, user memories, cart index), shared runtime config, keys/sync CLIs, stdio MCP servers, rules engine and project-rules reader, voice anchors.
- `packages/acp` — ACP adapter for ACP editors (Zed). **Fully local** — the agent loop, tool execution, and inference all run in-process on plugin-core with BYOK providers or local endpoints; the server is contacted only for the boot system prompt, key distribution, and encrypted sync.
- `packages/cc-plugin` — Claude Code distribution: Mimir persona, MCP wiring, lifecycle hooks, and the `mimir` wrapper command that launches Claude Code as Mimir.
- `packages/oc-plugin` — OpenCode distribution: in-process plugin bundle mirroring the cc-plugin brain legs.
- `packages/codex-plugin` — OpenAI Codex CLI distribution: lifecycle hooks + hook-trust ledger in a dedicated `CODEX_HOME` (`~/.mimir/codex`), AGENTS.md persona, and the `mimir-codex` wrapper. Codex hosts its own models; Mimir contributes the brain.

Editor-agnostic logic ships once in plugin-core with thin per-distribution wiring — never duplicated into a plugin package.

Shared dependencies are elevated to the root `package.json` catalogs (`ai-sdk`, `protocol`, `server`, `opencode`); reference them with `catalog:<name>`.
