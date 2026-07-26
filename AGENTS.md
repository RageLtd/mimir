
## Code Style

- No OOP. Plain functions, modules, data-over-abstraction. No classes unless the API demands it (e.g. ACP SDK's Agent interface requires a class).
- No explicit function return types — let TypeScript infer. See `.claude/rules/coding/return-types.md` for the why and the exceptions.
- No type casts (`as`) — if you need one, the types are wrong. The exception is serialisation boundaries (`JSON.parse`, `response.json()`, protocol fields typed as `unknown`) where TypeScript genuinely cannot know the shape without a runtime validation library. Casts at these boundaries are acceptable; casts inside the codebase are not.
- "Less code more gooder."

## Runtime

Default to using Bun instead of Node.js.



- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Repository Layout

Bun workspace — the root `package.json` defines `workspaces` plus dependency catalogs. Six packages:

- `packages/server` — mimir-server, deliberately **blind**: auth, wrapped-key distribution (`/v1/keys`, `/v1/members`), ciphertext sync (`/v1/sync`), `/v1/system-prompt`, operator-only `/mcp` introspection, and the browser admin/operator surfaces. It runs no models and parses no memory content. Inference, extraction, hygiene, embeddings, and persistence are all client-side (MIM-86, MIM-89).
- `packages/plugin-core` — backend-agnostic shared layer consumed by every editor adapter: brain (extraction, retrieval, summarization, hygiene, embedder), inference engine (provider registry, turn streaming), local stores (org replica, user memories, cart index), shared runtime config, keys/sync CLIs, stdio MCP servers, rules engine, voice anchors.
- `packages/acp` — ACP adapter for ACP editors (Zed). **Fully local** — the agent loop, tool execution, and inference all run in-process on plugin-core with BYOK providers or local endpoints; the server is contacted only for the boot system prompt, key distribution, and encrypted sync.
- `packages/cc-plugin` — Claude Code distribution: Mimir persona, MCP wiring, lifecycle hooks, and the `mimir` wrapper command that launches Claude Code as Mimir.
- `packages/oc-plugin` — OpenCode distribution: in-process plugin bundle mirroring the cc-plugin brain legs.
- `packages/codex-plugin` — OpenAI Codex CLI distribution: lifecycle hooks + hook-trust ledger in a dedicated `CODEX_HOME` (`~/.mimir/codex`), AGENTS.md persona, and the `mimir-codex` wrapper. Codex hosts its own models; Mimir contributes the brain.

Editor-agnostic logic ships once in plugin-core with thin per-distribution wiring — never duplicated into a plugin package.

Tests run through the root harness, never `bun test <path>`:

- `bun run test` — all packages
- `bun run test:server` / `test:plugin-core` / `test:acp` / `test:cc-plugin` / `test:oc-plugin` / `test:codex-plugin` — a single package

Shared dependencies are elevated to the root `package.json` catalogs (`ai-sdk`, `protocol`, `server`, `opencode`); reference them with `catalog:<name>`.
