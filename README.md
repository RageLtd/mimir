# Mimir

A coding agent with persistent memory, personality, and multi-provider inference. Mimir runs as three components: a server that owns knowledge and context, an ACP adapter that connects ACP editors (Zed) to the server's inference, and a Claude Code plugin that runs Mimir inside Claude Code against that same server.

## Architecture

```
Editor (Zed) ──ACP (stdio)──▶ @mimir/acp
                                  └── POST /v1/chat/completions ──▶ mimir-server
                                        └── vLLM / LM Studio / Zen / OpenRouter / any OpenAI-compatible provider

Claude Code ──plugin──▶ @mimir/cc-plugin
                                  ├── MCP (HTTP) ──▶ mimir-server /mcp
                                  │     └── Goldfish memory · Cartographer · web search
                                  ├── lifecycle hooks: persona system prompt, boot context,
                                  │     project rules, transcript persistence, cartographer reindex
                                  └── inference: Claude Code's own Anthropic plan (no API key)

mimir-server (shared by both paths):
  ├── System prompt + persona
  ├── Goldfish memories (vector search, SurrealDB)
  ├── Memory hygiene (background consolidation · contradiction · forgetting)
  ├── Conversation summaries (compaction) + persistence
  └── Knowledge tools (web search, Context7, Cartographer)

Local state (user's machine):
  ├── User memories (bun:sqlite, ~/.mimir/user-memories.db)
  └── Cartographer index (tree-sitter)
```

The two paths are independent. The ACP adapter routes **every** model through mimir-server's OpenAI-compatible API — there is no per-backend switch. The Claude Code plugin runs inside Claude Code (inference billed to your Anthropic plan) and reaches mimir-server only for memory, context, and knowledge tools over MCP.

## Packages

| Package | Description |
|---------|-------------|
| `packages/server` | Inference server, memory, context assembly, conversation persistence |
| `packages/acp` | ACP agent adapter — connects ACP editors (Zed) to mimir-server |
| `packages/cc-plugin` | Claude Code plugin — Mimir persona, MCP wiring, lifecycle hooks, and the `mimir` wrapper command |

## Prerequisites

- [Bun](https://bun.sh) v1.3+
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose (for the server)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (optional, to run the `cc-plugin`)

## Quick Start

```bash
git clone <repo-url> && cd mimir
bun install
```

### 1. Deploy the Server

The server runs in Docker alongside SurrealDB. Run from the repo root, where `docker-compose.yml` and `.env.example` live:

```bash
# Configure environment
cp .env.example .env
# Edit .env — at minimum set SURREAL_PASS and your inference provider(s)

# Start services
docker compose up -d
```

The committed `docker-compose.yml` pulls the prebuilt server image (`ghcr.io/rageltd/mimir-server:next`) from GitHub Container Registry rather than building. The image is **private**, so the host needs a one-time GHCR login before that first `docker compose up` can pull — the read-only token setup lives in [`packages/server/README.md`](packages/server/README.md#pulling-the-published-image).

The server exposes an OpenAI-compatible API at `http://localhost:8080` (or whatever `MIMIR_PORT` is set to), plus an Anthropic Messages-compatible ingress at `/v1/messages` for clients that speak that protocol. Caddy labels in the compose file expose it as `http://mimir.conhost.lan` if you're using caddy-docker-proxy.

#### Building from source instead of pulling

For local development — compiling your working tree instead of pulling `:next` — drop a `compose.override.yaml` next to `docker-compose.yml`. It's gitignored, and Compose auto-merges it on every command in that directory:

```yaml
services:
  mimir:
    build:
      context: .
      dockerfile: packages/server/Dockerfile
```

With `image:` (from the base file) and `build:` (from the override) both set, `docker compose up` builds locally and tags the result — no registry pull, no GHCR auth needed. A checkout without this file (a deploy host) pulls the published image untouched.

#### Server Environment Variables

`.env.example` is the canonical template — copy it and fill in the blanks. It covers the common variables; a few advanced knobs (the `CONTEXT_*`, `EMBED_*`, and full `SMALL_MODEL_*` sets) live in `packages/server/src/config.ts`. The critical ones:

**Required:**
- `SURREAL_PASS` — SurrealDB root password (must match between server and db)

**Inference providers (configure at least one):**
- `VLLM_BASE_URL` — local vLLM instance (e.g. `http://llm.spark.lan`)
- `LMSTUDIO_BASE_URL` — LM Studio's OpenAI-compatible server (models discovered from `/v1/models`)
- `OPENCODE_API_KEY` — OpenCode Zen gateway (the key name models.dev ships for the `opencode` provider). Set `ZEN_GO_ENABLED=true` to surface OpenCode Go subscription models
- `OPENROUTER_API_KEY` — OpenRouter multi-provider gateway
- `CHUTES_API_KEY` — Chutes gateway (activated via `provider-data.json`)

**Knowledge tools:**
- `EMBED_BASE_URL` / `EMBED_MODEL` — embedding endpoint and model (defaults to Ollama at `OLLAMA_BASE_URL`; required for Goldfish memory)
- `TAVILY_API_KEY` — web search tool
- `CONTEXT7_API_KEY` — documentation lookup (free tier works without key)

**Memory hygiene (background sweep):**
- `HYGIENE_MODEL` — judgment model for fusing merged memories; no default, the sweep refuses to run while unset
- `HYGIENE_DRY_RUN` — report proposed merges/prunes without mutating (default: `true`)
- See the `HYGIENE_*` block in `.env.example` for the full set of tuning knobs

**Context management:**
- `SYSTEM_PROMPT_PATH` — path to the system prompt markdown (default: `./system-prompt.md`)
- `CONTEXT_MAX_TOKENS` — model context window size (default: 262144)
- `CONTEXT_COMPACTION_THRESHOLD` — trigger compaction at this utilization (default: 0.8)

#### Verifying the Server

```bash
# Health check — shows status of all backend services
curl http://localhost:8080/health | jq

# Model list — should show your configured providers
curl http://localhost:8080/v1/models | jq '.data | length'
```

### 2. Configure the ACP Adapter

The ACP adapter connects your editor to mimir. Register it in Zed's settings:

**Zed → Settings → settings.json:**

```json
{
  "agent_servers": {
    "mimir-acp": {
      "type": "custom",
      "command": "bun",
      "args": ["run", "/path/to/mimir/packages/acp/index.ts"],
      "env": {
        "MIMIR_SERVER_URL": "http://mimir.conhost.lan"
      }
    }
  }
}
```

Replace the path and server URL with your actual values.

#### ACP Environment Variables

- `MIMIR_SERVER_URL` — mimir-server address (default: `http://mimir.conhost.lan`; override per machine)
- `MIMIR_API_KEY` — server API key (if you've configured auth)
- `MIMIR_MODEL` — default model (default: `openrouter/auto`)
- `MIMIR_USER_MEMORY_DB` — local user-memory SQLite path (default: `~/.mimir/user-memories.db`)
- `MIMIR_SESSION_DB` — local session SQLite path (default: `~/.mimir/sessions.db`)
- `MIMIR_ACP_LOG_FILE` — ACP log file; empty string disables file logging (default: `~/.mimir/logs/acp.log`)
- `AUTO_APPROVE_TOOLS` — auto-approve read/search tool calls (default: `false`)
- `MIMIR_SYSTEM_PROMPT_TTL` — system prompt cache TTL in ms (default: `300000` / 5 min)
- `MIMIR_CARTOGRAPHER_ENABLED` — enable cartographer integration (default: `true`)
- `MIMIR_CARTOGRAPHER_BIN` — cartographer binary path (default: `cartographer`, resolved on `PATH`)
- `LOG_LEVEL` — `debug`, `info`, `warn`, `error` (default: `info`)

### 3. Select a Model

Open the agent panel in Zed and pick a model from the dropdown. Every entry
resolves through mimir-server — your vLLM, Zen, and OpenRouter models appear
by name. Reasoning-capable models also expose a **Thought Level** selector
(none / low / medium / high).

To run Mimir on Anthropic models (Opus, Sonnet, Haiku), use the Claude Code
plugin below rather than the Zed dropdown.

### 4. (Optional) Install the Claude Code Plugin

`packages/cc-plugin` runs Mimir inside Claude Code. It installs the persona
system prompt, wires mimir-server's MCP endpoint (Goldfish memory,
Cartographer, web search) alongside the local user-memory store, registers
the lifecycle hooks, and adds a `mimir` wrapper that launches Claude Code as
Mimir. Inference is billed to your Anthropic plan — no API key needed.

The repo ships a local plugin marketplace at `.claude-plugin/marketplace.json`
(it resolves the `mimir-cc` plugin from `./packages/cc-plugin`). Add that
marketplace from your clone in Claude Code, install the plugin, then run
`/mimir-cc:mimir-install` to set up `~/.mimir/`, the wrapper, MCP servers, and
hooks. Launch sessions with the `mimir` command.

## Providers and Model Resolution

### How Models Are Resolved

When a request comes in with a model ID, the server resolves it through this chain:

1. **Provider prefix** — if the model ID has a `/` (e.g., `opencode-go/glm-5`), the part before the slash is treated as a provider hint, the part after as the model name. The provider must be initialized.
2. **Model index lookup** — the model ID is checked against the registry built at boot from `provider-data.json` plus dynamically discovered models from local endpoints.
3. **vLLM fallback** — if no provider is found and vLLM is configured, the model ID is passed to vLLM as-is.

### Provider Sources

The server builds its model registry from three sources at boot:

**1. Local providers (auto-discovered):**

Local providers are configured via base URL env vars. At boot, the server queries their `/v1/models` endpoints to discover available models.

| Provider | Env Var | Notes |
|----------|---------|-------|
| vLLM | `VLLM_BASE_URL` | Primary local inference. Models auto-discovered. |
| LM Studio | `LMSTUDIO_BASE_URL` | OpenAI-compatible local server (default port 1234). Models discovered from `/v1/models`; restart the server to pick up newly loaded models. |
| Ollama | `OLLAMA_BASE_URL` | Used for embeddings and the small utility model. |

**2. Remote providers (from provider-data.json):**

The server fetches `https://models.dev/api.json` at boot, which contains provider metadata, API endpoints, SDK types, and model lists with context window sizes. Providers are activated when their required env var contains an API key.

The JSON structure per provider:
```json
{
  "provider-id": {
    "id": "provider-id",
    "env": ["PROVIDER_API_KEY"],
    "npm": "@ai-sdk/openai-compatible",
    "api": "https://api.provider.com/v1",
    "name": "Provider Name",
    "models": {
      "model-id": {
        "id": "model-id",
        "name": "Display Name",
        "reasoning": true,
        "tool_call": true,
        "limit": { "context": 131072, "output": 8192 }
      }
    }
  }
}
```

When the server finds an API key for a provider's `env` field, it initializes an SDK and registers all of that provider's models.

**3. Gateway providers (cached model lists):**

| Provider | Env Var | Endpoint |
|----------|---------|----------|
| OpenCode Zen | `OPENCODE_API_KEY` | `ZEN_BASE_URL` (default: `https://opencode.ai/zen/v1`). `ZEN_GO_ENABLED=true` surfaces OpenCode Go models. |
| OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |

These fetch their model lists from their `/models` endpoints and cache them for 5 minutes.

### Adding a Custom Provider

**Local OpenAI-compatible server (easiest):**

If your provider exposes an OpenAI-compatible API, just set its base URL. For vLLM:

```bash
VLLM_BASE_URL=http://your-server:8000
```

Models are auto-discovered. Request them by the ID the server reports (e.g., `Qwen/Qwen3.5-122B-A10B`).

**Local OpenAI-compatible server with a UI (LM Studio):**

Point mimir-server at a running LM Studio instance:

```bash
LMSTUDIO_BASE_URL=http://localhost:1234
```

Models are whatever you've loaded in the LM Studio UI, discovered from `/v1/models` at boot. Restart mimir-server after loading new models to refresh the list. For an arbitrary **authenticated** gateway, use the provider-data.json path below rather than a bespoke env var.

**Provider from provider-data.json:**

If the provider is already in `models.dev`, just set its API key. Check the provider's `env` field in the JSON to see which env var it expects. For example, if the provider requires `DEEPSEEK_API_KEY`:

```bash
DEEPSEEK_API_KEY=your-key
```

All of that provider's models become available automatically.

**Models with non-default SDKs:**

Most providers use `@ai-sdk/openai-compatible`. Some require a specific SDK (Anthropic, Google, MoonshotAI, OpenAI, OpenRouter). The registry handles this through the `npm` field in `provider-data.json` — models can also override the provider's default SDK via a `provider.npm` field on the model entry. Supported SDKs: `@ai-sdk/anthropic`, `@ai-sdk/google` (and `@ai-sdk/google-vertex`), `@ai-sdk/moonshotai`, `@ai-sdk/openai`, `@openrouter/ai-sdk-provider`, `@ai-sdk/openai-compatible` (default).

### Model ID Conventions

When requesting a model, use one of these patterns:

- **Bare model ID**: `glm-5` — resolved through the registry index
- **Provider-prefixed**: `opencode-go/glm-5` — forces resolution through a specific provider
- **HuggingFace-style**: `Qwen/Qwen3.5-122B-A10B` — the part after the slash is also registered as a bare name

The model dropdown in Zed shows all registered models, every one resolved through mimir-server.

## How It Works

### ACP Adapter (Zed)

The editor sends messages through ACP to mimir-acp, which forwards them to mimir-server's `/v1/chat/completions` endpoint. The server runs the full middleware pipeline: system prompt injection, Goldfish memory retrieval, context assembly with summaries, tool classification, and the agent loop. Tool calls come back to mimir-acp for execution (filesystem ops forwarded to the editor, memory queries run locally).

### Claude Code Plugin

The `cc-plugin` runs Mimir inside Claude Code itself rather than spawning a subprocess. It installs as a Claude Code plugin: lifecycle hooks inject the persona system prompt, boot context, and project rules; an MCP connection to mimir-server's `/mcp` endpoint exposes Goldfish memory, Cartographer, and web search; a local stdio server exposes the user-memory store; and post-session hooks persist the transcript back to mimir-server and trigger cartographer reindexing. Claude Code handles inference (billed to your Anthropic plan) and its own tool execution.

The system prompt is converted from markdown to XML tags for Anthropic's models, with an additional model override block that suppresses Claude's default personality patterns.

### Memory System

**Goldfish** (server-side) — conversation-level memories stored in SurrealDB with vector embeddings. Automatically extracted from conversations and retrieved by relevance on each request. Compacted into summaries when the context window fills up.

**User memories** (local) — static profile facts and queryable entries stored in SQLite on the user's machine. Profile entries are injected into every request. Queryable memories are available as tools the model can call.

**Memory hygiene** (server-side) — a background sweep keeps the Goldfish store healthy on a timer (default every 6 hours, in-process, guarded by a DB lock). It runs three ordered passes: consolidation fuses near-duplicate memories into one canonical record, contradiction resolution demotes the losing side of conflicting facts and records a supersedes edge, and forgetting prunes low-value facts past an age and score floor. It defaults to dry-run (reports proposed changes without mutating) and refuses to run until `HYGIENE_MODEL` is set. Trigger a manual sweep with `POST /v1/hygiene/sweep`; see `packages/server/docs/memory-hygiene.md` for the full design and the `HYGIENE_*` block in `.env.example` for the tuning knobs.

### Context Assembly

Every request gets assembled context regardless of backend:
1. System prompt (personality, rules, tool usage patterns)
2. Recent conversation summaries (from Goldfish compaction)
3. Relevant memories (vector search against the current query)
4. User profile (from local SQLite)
5. Conversation history (from the message log)

## Development

```bash
# Run the ACP adapter in dev mode
bun run acp:start

# Run the server in dev mode (outside Docker, with --watch)
bun run server:dev

# Build the Claude Code plugin binaries
bun run cc-plugin:build

# Lint + format (biome)
bun run check

# Run tests — always via the root harness, never `bun test <path>`
bun run test            # all packages
bun run test:server     # or a single package
bun run test:acp
bun run test:cc-plugin
```

## Project Structure

```
mimir/
├── packages/
│   ├── acp/                    # ACP agent adapter (server backend only)
│   │   ├── src/
│   │   │   ├── agent/          # Agent loop, session, model resolution, commands
│   │   │   ├── backends/       # Backend abstraction — server only
│   │   │   ├── cartographer/   # Cartographer index sync client
│   │   │   ├── client-mcp/     # MCP servers exposed to the editor
│   │   │   ├── mcp-config/     # MCP configuration assembly
│   │   │   ├── project/        # Project resolution
│   │   │   ├── rules/          # Project-rule loader + runner
│   │   │   ├── store/          # Local user memory (bun:sqlite)
│   │   │   ├── tools/          # User memory tools
│   │   │   ├── types/          # Shared type declarations
│   │   │   ├── utils/          # Helpers
│   │   │   ├── config.ts       # Configuration (env vars)
│   │   │   ├── context-client.ts # REST client for mimir-server context
│   │   │   ├── permissions.ts  # Tool permission gating
│   │   │   ├── server-client.ts  # HTTP client for mimir-server completions
│   │   │   └── sse-parser.ts   # SSE stream parsing
│   │   └── index.ts            # Entry point
│   │
│   ├── cc-plugin/              # Claude Code plugin (@mimir/cc-plugin)
│   │   ├── .claude-plugin/     # plugin.json manifest
│   │   ├── artifacts/          # mcp.json / settings.json / wrapper.sh templates
│   │   ├── commands/           # Slash commands (mimir-install, mimir-update, switch-model)
│   │   ├── src/
│   │   │   ├── *-hook.ts       # Lifecycle hooks (session-start, persist, precompact, reindex, …)
│   │   │   ├── boot-context.ts # Cross-session context snapshot
│   │   │   ├── voice-anchor.ts # Persona voice enforcement
│   │   │   ├── markdown-to-xml.ts # System-prompt markdown → XML
│   │   │   ├── cartographer/   # Index sync client
│   │   │   ├── project/ rules/ store/ tools/
│   │   │   └── cli.ts          # `mimir` wrapper entry point
│   │   └── build.sh            # Compiles per-platform binaries
│   │
│   └── server/                 # Inference server (@mimir/server)
│       ├── src/
│       │   ├── agent/          # Provider registry, agent runner
│       │   ├── agent-loop/     # Message log, compaction, providers, server tools
│       │   ├── db/             # SurrealDB client
│       │   ├── goldfish/       # Memory storage, retrieval, extraction, hygiene
│       │   ├── middleware/     # System prompt, memories, context assembly
│       │   ├── projects/       # Project registry
│       │   ├── routes/         # HTTP + MCP endpoints
│       │   └── util/           # Logging, result type
│       ├── docs/               # Server docs (memory hygiene, …)
│       ├── provider-data.json  # Provider + model registry (refreshed from models.dev)
│       ├── system-prompt.md    # Mimir's personality and rules
│       └── Dockerfile
│
├── tests/run-tests.ts          # Root test harness (bun run test[:pkg])
├── docker-compose.yml          # Server + SurrealDB (pulls the published image)
├── .env.example                # Server environment template
├── .claude-plugin/             # Local plugin marketplace (marketplace.json)
├── mimir-mcp.json              # Sample MCP config (mimir + context7 servers)
└── biome.json                  # Shared linting config
```
