# TODO

## Features

- [ ] Add support for AskUserQuestion (blocked: ACP has no `user_input_request` session update type — no way to present structured questions to the user mid-turn via Zed. Currently in `disallowedTools`. Revisit when ACP spec adds a user prompt primitive)
- [x] Investigate giving Mimir more expressive freedom in the system prompt
- [x] Copilot CLI backend via `@github/copilot-sdk`. Full SDK integration — adapter, runner (async push-queue bridging callbacks to generator), MCP config, formatting with `mode: "replace"` system prompt. Models discovered dynamically at startup via `CopilotClient.listModels()` and merged into the ACP model picker. Routing by `copilot/` prefix in `routing.ts`. Full test coverage (adapter, formatting, mcp-config, push-queue, routing). Graceful degradation when CLI unavailable
- [x] TodoWrite → ACP plan updates. Copilot backend emits plan session updates alongside tool cards (matching Zed's reference implementation — no suppression)
- [x] Compaction small-model fallback. `summarizeConversation` falls back to the configured small model (Ollama) when the request model ID (`claude-code/opus`, `copilot/*`) isn't in the server's provider registry
- [x] Compaction absolute threshold check. Fixed bug where first token report after fresh start set baseline without checking whether tokens already exceeded threshold. Added `promptTokens >= threshold` alongside incremental `tokens_since_last >= threshold`
- [x] Test runner moved to project root (`tests/run-tests.ts`). Each test file runs in its own subprocess to prevent `mock.module` pollution. Root `package.json` scripts: `test`, `test:server`, `test:acp`

## Refactoring

- [x] Refactor hook classes to functional style (packages/server/src/hooks/)
- [x] Split oversized files: agent/run.ts → agent/run/ (loop, response, prompt, tools, index); provider/registry.ts → registry.ts + query.ts. All production files now under 500 lines
- [x] Eliminate `as` type casts — SQLite boundary casts fixed via `db.query<T>()` generics; result.ts structural casts fixed. JSON.parse / JSON-RPC boundary casts intentionally kept — TypeScript has no pattern matching, and `as` at serialisation boundaries is the correct tool. Rules updated to codify the serialisation boundary exception
