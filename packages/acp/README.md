# @mimir/acp

ACP (Agent Client Protocol) agent layer for Mimir. Bridges editor agent panels — primarily Zed — to the Claude Code Agent SDK and mimir-server, providing a unified coding agent experience with persistent memory, codebase indexing, and user-aware context.

## Architecture

```
Editor (Zed)           mimir-acp (this package)         External Services
┌──────────┐          ┌─────────────────────────┐      ┌──────────────────┐
│ Agent    │◄─stdio──►│ ACP Connection (NDJSON)  │      │                  │
│ Panel    │          │                         │      │ mimir-server     │
│          │          │ Agent Core              │      │  ├─ /mcp         │
│ Model    │          │  ├─ Session management   │◄────►│  ├─ /v1/context │
│ Selector │          │  ├─ Backend routing      │      │  └─ /v1/models  │
│          │          │  └─ Tool reporting       │      │                  │
│ Terminal │          │                         │      │ Claude Code SDK  │
│ Output   │          │ Backends                │◄────►│  └─ query()      │
│          │          │  ├─ claude-code (SDK)    │      │                  │
└──────────┘          │  └─ server (HTTP+SSE)   │      │ MCP Servers      │
                      │                         │      │  ├─ user-memory  │
                      │ Local Stores            │      │  └─ context7     │
                      │  ├─ User memories (SQLite)│     └──────────────────┘
                      │  └─ Sessions (SQLite)   │
                      │                         │
                      │ Cartographer (optional)  │
                      │  └─ Tree-sitter indexer  │
                      └─────────────────────────┘
```

## Backends

Backend selection is per-request, driven by the model ID prefix. Users can switch backends mid-conversation via the editor's model dropdown.

### Claude Code (`claude-code/*` models)

Uses `query()` from `@anthropic-ai/claude-agent-sdk`. The SDK manages sessions, auth (via `CLAUDE_CODE_OAUTH_TOKEN`), and tool execution internally. mimir-acp observes tool calls and results for editor display but does not execute them — CC handles its own tool loop.

Three MCP servers are wired into each SDK session:

- **mimir** (HTTP) — Goldfish memory, Cartographer indexing, web search, introspection via mimir-server's `/mcp` endpoint
- **user-memory** (stdio) — local SQLite-backed user profile and memory management
- **context7** (stdio) — library documentation lookup

### Server (`*` all other models)

Routes through mimir-server's OpenAI-compatible `/v1/chat/completions` endpoint. The agent loop executes tool calls locally or forwards them to the editor via ACP. Used for models running on vLLM, OpenRouter, or any other provider configured in mimir-server.

## Source Layout

```
src/
├── agent/                  # ACP agent factory, session management, prompt dispatch
│   ├── index.ts            # Agent factory — the public entry point
│   ├── core.ts             # AgentCore: prompt routing, mode/model switching
│   ├── session.ts          # Session state management
│   ├── types.ts            # Shared agent types (SessionState, AgentCore)
│   ├── content.ts          # ACP content block formatting and conversion
│   ├── tool-reporting.ts   # Tool call display: kinds, titles, diff content
│   ├── client-tools.ts     # ACP client tool forwarding (readTextFile, etc.)
│   └── prompt-server.ts    # Server backend prompt path with tool interception
│
├── backends/               # Backend abstraction and implementations
│   ├── types.ts            # Backend interface, BackendEvent, BackendRunOptions
│   ├── index.ts            # Backend factory and router
│   ├── server.ts           # mimir-server HTTP+SSE backend adapter
│   └── claude-code/        # Claude Code Agent SDK backend
│       ├── index.ts        # Barrel exports
│       ├── adapter.ts      # Backend interface → runClaudeCode bridge
│       ├── runner.ts       # SDK query() invocation and event translation
│       ├── formatting.ts   # Context formatting and SDK option building
│       ├── mcp-config.ts   # MCP server config builder for the SDK
│       └── prompt-cc.ts    # Context assembly, system prompt, event dispatch
│
├── cartographer/           # Tree-sitter codebase indexing integration
│   ├── client.ts           # Cartographer binary client
│   ├── lifecycle.ts        # Startup/shutdown management
│   └── sync.ts             # File change detection and re-indexing
│
├── store/                  # Local SQLite data stores
│   ├── user-memories.ts    # User profile and memory CRUD (bun:sqlite)
│   └── sessions.ts         # Session persistence
│
├── tools/                  # MCP tool implementations
│   ├── user-memory.ts      # User memory tool definitions and context builder
│   └── user-memory-mcp.ts  # Stdio MCP server for user memory (JSON-RPC 2.0)
│
├── utils/                  # Shared utilities
│   ├── log.ts              # Pino logger setup
│   └── markdown-to-xml.ts  # Markdown → XML prompt conversion with CC-specific blocks
│
├── config.ts               # Environment-based configuration
├── routing.ts              # Model-based backend routing and model list management
├── context-client.ts       # mimir-server context assembly client
├── server-client.ts        # mimir-server API types and HTTP client
├── sse-parser.ts           # SSE stream parser for server backend
└── util.ts                 # Shared error utilities
```

## Configuration

All configuration is via environment variables. See `src/config.ts` for the full list with defaults.

| Variable | Default | Description |
|---|---|---|
| `MIMIR_SERVER_URL` | `http://mimir.conhost.lan:3777` | mimir-server base URL |
| `MIMIR_API_KEY` | (empty) | API key for mimir-server |
| `MIMIR_MODEL` | `openrouter/auto` | Default model for the server backend |
| `MIMIR_USER_MEMORY_DB` | `~/.mimir/user-memories.db` | SQLite database for user memories |
| `MIMIR_SESSION_DB` | `~/.mimir/sessions.db` | SQLite database for sessions |
| `MIMIR_CC_ENABLED` | `true` | Enable/disable Claude Code backend |
| `MIMIR_CC_PERMISSION_MODE` | `bypassPermissions` | CC permission mode |
| `MIMIR_CC_DISALLOWED_TOOLS` | (see config.ts) | Comma-separated CC tools to disable |
| `MIMIR_CC_WORKING_DIR` | (cwd) | Override CC working directory |
| `MIMIR_CARTOGRAPHER_ENABLED` | `true` | Enable Cartographer indexing |
| `MIMIR_CARTOGRAPHER_BIN` | `cartographer` | Path to Cartographer binary |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |

## Running

```bash
# Development (stdio — connect via Zed's ACP agent config)
bun run start

# Compile to standalone binary
bun run build
```

The agent communicates via NDJSON over stdin/stdout per the ACP specification. Configure Zed to spawn it as an ACP agent in the editor's agent settings.

## Testing

```bash
bun test
```

Tests are colocated with their source files. The test suite covers content block conversion, context formatting, SDK option building, MCP server config merging, and the prompt pipeline.
