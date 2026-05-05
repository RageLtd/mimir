# Mimir

A coding agent with persistent memory, personality, and multi-provider inference. Mimir runs as two components: a server that owns knowledge and context, and an ACP adapter that connects your editor to inference backends.

## Architecture

```
Editor (Zed) ──ACP (stdio)──▶ @mimir/acp (user's machine)
                                  │
                                  ├── Backend: mimir-server
                                  │     POST /v1/chat/completions
                                  │     └── vLLM / Zen / OpenRouter / any OpenAI-compatible provider
                                  │
                                  ├── Backend: Claude Code
                                  │     claude -p (subprocess, pipe mode)
                                  │     └── Opus / Sonnet via Pro plan, no API key needed
                                  │
                                  ├── Context from mimir-server (both backends):
                                  │     ├── System prompt (cached)
                                  │     ├── Goldfish memories (vector search)
                                  │     ├── Conversation summaries (compaction)
                                  │     └── Conversation persistence
                                  │
                                  └── Local state:
                                        ├── User memories (bun:sqlite)
                                        └── Cartographer index (tree-sitter)
```

Backend selection is per-request via the model dropdown in your editor. Models prefixed with `claude-code/` route through a Claude Code subprocess. Everything else routes through mimir-server.

## Packages

| Package | Description |
|---------|-------------|
| `packages/server` | Inference server, memory, context assembly, conversation persistence |
| `packages/acp` | ACP agent adapter — connects editors to inference backends |

## Prerequisites

- [Bun](https://bun.sh) v1.3+
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose (for the server)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (optional, for the CC backend)

## Quick Start

```bash
git clone <repo-url> && cd mimir
bun install
```

### 1. Deploy the Server

The server runs in Docker alongside SurrealDB.

```bash
cd packages/server

# Configure environment
cp .env.example .env
# Edit .env — at minimum set SURREAL_PASS and your inference provider(s)

# Start services
docker compose up -d
```

The server exposes an OpenAI-compatible API at `http://localhost:8080` (or whatever `MIMIR_PORT` is set to). Caddy labels in the compose file expose it as `http://mimir.conhost.lan` if you're using caddy-docker-proxy.

#### Server Environment Variables

The `.env.example` documents all available variables. The critical ones:

**Required:**
- `SURREAL_PASS` — SurrealDB root password (must match between server and db)

**Inference providers (configure at least one):**
- `VLLM_BASE_URL` — local vLLM instance (e.g. `http://llm.spark.lan`)
- `ZEN_API_KEY` / `ZEN_BASE_URL` — OpenCode Zen gateway
- `OPENROUTER_API_KEY` — OpenRouter multi-provider gateway

**Knowledge tools:**
- `OLLAMA_BASE_URL` — Ollama for embeddings (required for Goldfish memory)
- `TAVILY_API_KEY` — web search tool
- `CONTEXT7_API_KEY` — documentation lookup (free tier works without key)

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

- `MIMIR_SERVER_URL` — mimir-server address (**required**, no default that works across machines)
- `MIMIR_API_KEY` — server API key (if you've configured auth)
- `MIMIR_MODEL` — default model for the server backend (default: `openrouter/auto`)
- `MIMIR_SYSTEM_PROMPT_TTL` — system prompt cache TTL in ms (default: `300000` / 5 min)
- `MIMIR_CC_ENABLED` — enable/disable Claude Code backend (default: auto-detected from PATH)
- `MIMIR_CC_MCP_CONFIG` — path to MCP config for CC (default: `./mimir-mcp.json`)
- `MIMIR_CC_PERMISSION_MODE` — CC permission mode (default: `bypassPermissions`)
- `MIMIR_CC_WORKING_DIR` — working directory for CC subprocess
- `LOG_LEVEL` — `debug`, `info`, `warn`, `error` (default: `info`)

### 3. Select a Model

Open the agent panel in Zed and pick a model from the dropdown:

- **Server models** — your vLLM, Zen, OpenRouter models appear by name
- **Claude Code (opus)** — Opus via Claude Code subprocess
- **Claude Code (sonnet)** — Sonnet via Claude Code subprocess
- **Claude Code (opus-1m)** — Opus with 1M context window
- **Claude Code (sonnet-1m)** — Sonnet with 1M context window
- **Claude Code (haiku)** — Haiku for simple tasks

Claude Code models require the `claude` CLI installed and authenticated. No API key needed — it uses your Pro/Max plan.

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
| Ollama | `OLLAMA_BASE_URL` | Used for embeddings and small models. |
| Featherless | `FEATHERLESS_BASE_URL` + `FEATHERLESS_API_KEY` | Set `FEATHERLESS_MODEL` for the model ID (default: `Qwen/Qwen3.5-397B-A17B`). |

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
| OpenCode Zen | `ZEN_API_KEY` | `ZEN_BASE_URL` (default: `https://opencode.ai/zen/v1`) |
| OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |

These fetch their model lists from their `/models` endpoints and cache them for 5 minutes.

### Adding a Custom Provider

**Local OpenAI-compatible server (easiest):**

If your provider exposes an OpenAI-compatible API, just set its base URL. For vLLM:

```bash
VLLM_BASE_URL=http://your-server:8000
```

Models are auto-discovered. Request them by the ID the server reports (e.g., `Qwen/Qwen3.5-122B-A10B`).

**Any OpenAI-compatible endpoint with auth:**

Use the Featherless pattern:

```bash
FEATHERLESS_BASE_URL=https://api.your-provider.com/v1
FEATHERLESS_API_KEY=your-key
FEATHERLESS_MODEL=org/model-name
```

**Provider from provider-data.json:**

If the provider is already in `models.dev`, just set its API key. Check the provider's `env` field in the JSON to see which env var it expects. For example, if the provider requires `DEEPSEEK_API_KEY`:

```bash
DEEPSEEK_API_KEY=your-key
```

All of that provider's models become available automatically.

**Models with non-default SDKs:**

Most providers use `@ai-sdk/openai-compatible`. Some require a specific SDK (Anthropic, Google, MoonshotAI). The registry handles this through the `npm` field in `provider-data.json` — models can also override the provider's default SDK via a `provider.npm` field on the model entry. Supported SDKs: `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/moonshotai`, `@ai-sdk/openai-compatible` (default).

### Model ID Conventions

When requesting a model, use one of these patterns:

- **Bare model ID**: `glm-5` — resolved through the registry index
- **Provider-prefixed**: `opencode-go/glm-5` — forces resolution through a specific provider
- **HuggingFace-style**: `Qwen/Qwen3.5-122B-A10B` — the part after the slash is also registered as a bare name

The model dropdown in Zed shows all registered models. Claude Code models are prefixed with `claude-code/` and handled entirely by the ACP adapter.

## How It Works

### Server Backend

The editor sends messages through ACP to mimir-acp, which forwards them to mimir-server's `/v1/chat/completions` endpoint. The server runs the full middleware pipeline: system prompt injection, Goldfish memory retrieval, context assembly with summaries, tool classification, and the agent loop. Tool calls come back to mimir-acp for execution (filesystem ops forwarded to the editor, memory queries run locally).

### Claude Code Backend

mimir-acp fetches context from mimir-server (system prompt, relevant memories, conversation summaries), assembles it into a prompt, and spawns `claude -p` as a subprocess. Claude Code handles its own tool execution (file reads, writes, bash commands) internally. mimir-acp observes tool calls from the stream for editor visibility and persists the conversation back to mimir-server after completion.

The system prompt is converted from markdown to XML tags for Anthropic's models, with an additional model override block that suppresses Claude's default personality patterns.

### Memory System

**Goldfish** (server-side) — conversation-level memories stored in SurrealDB with vector embeddings. Automatically extracted from conversations and retrieved by relevance on each request. Compacted into summaries when the context window fills up.

**User memories** (local) — static profile facts and queryable entries stored in SQLite on the user's machine. Profile entries are injected into every request. Queryable memories are available as tools the model can call.

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
cd packages/server && bun run dev

# Run all checks (biome)
bun run check

# Run server tests
cd packages/server && bun test
```

## Project Structure

```
mimir/
├── packages/
│   ├── acp/                    # ACP agent adapter
│   │   ├── src/
│   │   │   ├── agent/          # Agent loop, prompt paths (server + CC)
│   │   │   ├── backends/       # Backend abstraction (server, claude-code)
│   │   │   ├── store/          # Local user memory (bun:sqlite)
│   │   │   ├── tools/          # User memory tools
│   │   │   ├── utils/          # Logging, markdown-to-xml
│   │   │   ├── config.ts       # Configuration
│   │   │   ├── context-client.ts # REST client for mimir-server context
│   │   │   ├── routing.ts      # Model-based backend routing
│   │   │   ├── server-client.ts # HTTP client for mimir-server completions
│   │   │   └── sse-parser.ts   # SSE stream parsing
│   │   └── index.ts            # Entry point
│   │
│   └── server/                 # Inference server
│       ├── src/
│       │   ├── agent/          # Provider registry, agent runner
│       │   ├── agent-loop/     # Message log, compaction, server tools
│       │   ├── db/             # SurrealDB client
│       │   ├── goldfish/       # Memory storage, retrieval, extraction
│       │   ├── hooks/          # Behavioral enforcement
│       │   ├── middleware/     # System prompt, memories, context assembly
│       │   ├── routes/         # HTTP endpoints
│       │   └── util/           # Logging, result type
│       ├── system-prompt.md    # Mimir's personality and rules
│       ├── docker-compose.yml  # Server + SurrealDB
│       └── Dockerfile
│
├── mimir-mcp.json              # Empty MCP config (strips CC account servers)
└── biome.json                  # Shared linting config
```
