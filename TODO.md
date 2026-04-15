# TODO

## Features

- [ ] Add support for AskUserQuestion (blocked: ACP has no `user_input_request` session update type — no way to present structured questions to the user mid-turn via Zed. Currently in `disallowedTools`. Revisit when ACP spec adds a user prompt primitive)
- [x] Investigate giving Mimir more expressive freedom in the system prompt
- [ ] Add Copilot CLI as a backend via ACP (`copilot --acp --stdio`). Copilot speaks ACP natively so the backend module should be thin — spawn, pipe stdio, done. Known issue: Copilot auto-approves tool ops in ACP mode instead of sending `session/request_permission` to the client (github/copilot-cli#845), so mimir-acp can't gate permissions. Also verify that Copilot's ACP content block types (especially plan mode and specialized agent delegation) map cleanly to mimir-acp's expected content blocks.

## Refactoring

- [x] Refactor hook classes to functional style (packages/server/src/hooks/)
- [ ] Split oversized files: agent/run.ts (736 lines), provider/registry.ts (674 lines)
- [ ] Eliminate remaining `as` type casts across codebase
