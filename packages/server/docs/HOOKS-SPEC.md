# Hooks System Spec

## Problem

mimir-server's system prompt defines rules for action safety, tool hierarchy,
and destructive action confirmation. These rules are enforced by asking the
model to follow them. Models don't always follow them. System prompts are
suggestions — harness logic is law.

The hooks system makes behavioral rules structurally enforceable by
intercepting tool calls at defined lifecycle points.

## Architecture Overview

```
Developer request
  → prepareAgent()
  → AI SDK generateText/streamText
       ├─ Server tool call → PreToolUse hook → execute() → PostToolUse hook
       ├─ Server tool call → PreToolUse hook → BLOCKED (returns denial to model)
       └─ Client tool call → PreToolUse hook → SSE chunk to client
  → Response
```

Three hook points:

1. **PreToolUse** — Fires before a tool executes. Can approve, deny, or
   modify the call. Denial returns a structured message to the model
   explaining why the call was blocked.

2. **PostToolUse** — Fires after a tool executes. Can inspect/log results,
   trigger side effects (e.g. Cartographer re-index after file write),
   or transform the result before the model sees it.

3. **Lifecycle** — Session-level events: session start, compaction triggered,
   context threshold reached. Not tool-specific.

## Tool Categories

### Server tools (have `execute`)

Server tools run autonomously inside the AI SDK agent loop. The model calls
them, the SDK invokes `execute()`, and the result feeds back into the next
model turn. No human approval exists in this path today.

Hook strategy: wrap each tool's `execute` function with a hook-aware
wrapper at registration time (in `buildTools()`). The wrapper calls
PreToolUse hooks before invoking the original execute, and PostToolUse
hooks after.

### Client tools (no `execute`)

Client tools are returned as `tool_calls` in the response stream. The
client (Zed, OpenCode) receives them, executes them on the developer's
machine, and sends results back in the next request. The client typically
has its own approval UI.

Hook strategy: intercept in the stream processor before emitting the
tool_call SSE chunk. PreToolUse hooks can block the tool_call from
reaching the client entirely — the model gets a denial message and must
choose a different approach.

This is a backstop, not the primary gate. Client-side approval is the
developer-facing UX. Server-side hooks catch things the model shouldn't
even attempt.

## Hook Interface

```typescript
/** Context passed to every hook */
interface HookContext {
  /** Tool being called */
  toolName: string;
  /** Tool arguments */
  args: Record<string, unknown>;
  /** Whether this is a server tool or client tool */
  toolType: "server" | "client";
  /** Current project path (if known) */
  project: string | null;
  /** Conversation fingerprint */
  fingerprint: string | null;
}

/** Result of a PreToolUse hook */
type PreToolUseResult =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "modify"; args: Record<string, unknown> };

/** PreToolUse hook function */
type PreToolUseHook = (
  ctx: HookContext,
) => PreToolUseResult | Promise<PreToolUseResult>;

/** PostToolUse hook function */
type PostToolUseHook = (
  ctx: HookContext & { result: unknown; durationMs: number },
) => void | Promise<void>;

/** Lifecycle event types */
type LifecycleEvent =
  | { type: "session_start"; project: string | null; fingerprint: string | null }
  | { type: "compaction_triggered"; fingerprint: string; tokenCount: number }
  | { type: "context_threshold"; fingerprint: string; utilization: number };

type LifecycleHook = (event: LifecycleEvent) => void | Promise<void>;
```

## Hook Registration

```typescript
interface HookRegistry {
  /** Register a PreToolUse hook. Optionally filter by tool name pattern. */
  onPreToolUse(hook: PreToolUseHook, filter?: ToolFilter): void;

  /** Register a PostToolUse hook. Optionally filter by tool name pattern. */
  onPostToolUse(hook: PostToolUseHook, filter?: ToolFilter): void;

  /** Register a lifecycle hook */
  onLifecycle(hook: LifecycleHook): void;
}

/** Filter which tools a hook applies to */
interface ToolFilter {
  /** Exact tool names */
  names?: string[];
  /** Glob/regex pattern against tool name */
  pattern?: RegExp;
  /** Tool type filter */
  type?: "server" | "client";
}
```

## Hook Execution Order

1. PreToolUse hooks run in registration order.
2. First `deny` result short-circuits — remaining hooks are skipped.
3. `modify` results are cumulative — each hook sees the args from the
   previous hook's modifications.
4. PostToolUse hooks run in registration order, always (even on error).
5. PostToolUse hooks are fire-and-forget — they don't block the response.

## Built-in Hooks

### Destructive Action Guard (PreToolUse)

Enforces the "Executing Actions with Care" rules structurally:

```typescript
const DESTRUCTIVE_PATTERNS = [
  // Git — hard to reverse
  { tool: /^bash$/, args: /git\s+push\s+--force/ },
  { tool: /^bash$/, args: /git\s+reset\s+--hard/ },
  { tool: /^bash$/, args: /git\s+branch\s+-[dD]/ },
  { tool: /^bash$/, args: /git\s+checkout\s+\./ },
  { tool: /^bash$/, args: /git\s+clean\s+-f/ },
  // File — destructive
  { tool: /^bash$/, args: /rm\s+-rf/ },
  { tool: /^bash$/, args: /rm\s+.*-r/ },
  // Process — irreversible
  { tool: /^bash$/, args: /kill\s+-9/ },
  { tool: /^bash$/, args: /pkill/ },
  // Skip hooks — safety bypass
  { tool: /^bash$/, args: /--no-verify/ },
];
```

When a destructive pattern matches, the hook returns:
```typescript
{
  action: "deny",
  reason: "This is a destructive action that requires explicit developer approval. Present your plan and ask before proceeding."
}
```

The model receives this as the tool result and must ask the developer for
permission.

### Tool Hierarchy Enforcer (PreToolUse)

Detects when the model uses a shell command when a dedicated tool exists:

```typescript
const SHELL_SUBSTITUTIONS: Record<string, RegExp> = {
  "read":  /\b(cat|head|tail)\b/,
  "edit":  /\b(sed|awk)\b/,
  "write": /\becho\b.*>>|\bcat\b.*<<|\btee\b/,
  "glob":  /\b(find|ls)\b/,
  "grep":  /\b(grep|rg|ag)\b/,
};
```

When the model calls bash with a command matching a substitution, and the
dedicated tool exists in the current tool set, the hook returns:
```typescript
{
  action: "deny",
  reason: `Use the dedicated '${dedicatedTool}' tool instead of '${matched}'. Shell commands are a last resort.`
}
```

This only fires when the dedicated tool is actually available — if the
client doesn't provide a read tool, bash cat is fine.

### Cartographer Post-Edit Trigger (PostToolUse)

After any tool call that modifies files, trigger Cartographer re-index:

```typescript
registry.onPostToolUse(async (ctx) => {
  const filePath = ctx.args.path as string;
  if (filePath) {
    await cartographerDetectChanges(filePath);
  }
}, {
  names: ["write", "edit", "create"],
  type: "client",
});
```

### Background Task Manager (PreToolUse + PostToolUse)

Detects long-running shell commands and automatically backgrounds them
with log file output, so the model and developer both have visibility.

**PreToolUse (modify):** When a bash command matches a known long-running
pattern and the model hasn't already backgrounded it, the hook rewrites
the command to redirect output and run in the background:

```typescript
const LONG_RUNNING_PATTERNS = [
  // Builds
  /\bcargo\s+(build|check|clippy|test)\b/,
  /\bnpm\s+(run\s+build|test|install)\b/,
  /\bbun\s+(build|test|install)\b/,
  /\bmake\b/,
  /\bcmake\s+--build\b/,
  /\bdocker\s+(build|compose\s+up)\b/,
  // Linting / type checking
  /\btsc\b(?!.*--noEmit.*--watch)/,
  /\beslint\b.*\./,
  // Package operations
  /\bcargo\s+add\b/,
  /\bnpm\s+install\b/,
];
```

When a match is found and the command doesn't already contain `&`, `nohup`,
or output redirection:

```typescript
// Generate a predictable log path from the command type
const taskType = detectTaskType(command); // "build", "test", "lint", etc.
const logPath = `/tmp/mimir-${taskType}-${Date.now()}.log`;

return {
  action: "modify",
  args: {
    ...ctx.args,
    command: `${command} 2>&1 | tee ${logPath} &`,
    // Store metadata for the PostToolUse hook
    _background: { logPath, taskType, startedAt: Date.now() },
  },
};
```

**PostToolUse (notify):** After the backgrounded command is dispatched,
the hook appends monitoring instructions to the tool result so the model
relays them to the developer:

```typescript
registry.onPostToolUse((ctx) => {
  const bg = ctx.args._background as BackgroundMeta | undefined;
  if (!bg) return;

  // Track the background task
  taskTracker.add({
    logPath: bg.logPath,
    taskType: bg.taskType,
    startedAt: bg.startedAt,
    fingerprint: ctx.fingerprint,
  });

  // Append monitoring info to the result
  // (requires PostToolUse to support result modification — see Open Questions)
  // If not, the system prompt instruction handles this.
}, { names: ["bash"], type: "client" });
```

**Task tracker:** An in-memory store of active background tasks per
conversation. The model or a lifecycle hook can query it to check
completion status before proceeding with dependent work:

```typescript
interface BackgroundTask {
  logPath: string;
  taskType: string;
  startedAt: number;
  fingerprint: string | null;
  pid?: number;
}

interface TaskTracker {
  /** Register a new background task */
  add(task: BackgroundTask): void;
  /** Get active tasks for a conversation */
  active(fingerprint: string): BackgroundTask[];
  /** Check if a task's log indicates completion (scan for exit code) */
  checkCompletion(task: BackgroundTask): Promise<"running" | "success" | "failed">;
  /** Remove completed tasks */
  prune(fingerprint: string): void;
}
```

The model can check task status via a server tool (or the harness can
inject status into context automatically on the next request):

```typescript
// In prepareAgent(), after resolving messages:
const activeTasks = taskTracker.active(fingerprint);
if (activeTasks.length > 0) {
  const statuses = await Promise.all(
    activeTasks.map(async (t) => ({
      type: t.taskType,
      log: t.logPath,
      status: await taskTracker.checkCompletion(t),
      elapsed: `${Math.round((Date.now() - t.startedAt) / 1000)}s`,
    })),
  );
  // Inject into dynamic system prompt
  sessionContext.backgroundTasks = statuses;
}
```

This gives the model awareness of pending tasks without it needing to
remember to check. If a build is still running, the model sees it in
context and can wait or work on something else. If it failed, the model
sees the failure and can report it.

### Audit Logger (PostToolUse)

Log all tool calls with timing:

```typescript
registry.onPostToolUse((ctx) => {
  log.info({
    tool: ctx.toolName,
    type: ctx.toolType,
    durationMs: ctx.durationMs,
    project: ctx.project,
  }, "tool_call_audit");
});
```

## Integration Points

### Server tools: wrapping execute

In `buildTools()` (agent.ts), wrap each server tool:

```typescript
function wrapWithHooks(
  toolName: string,
  originalExecute: (...args: any[]) => Promise<unknown>,
  registry: HookRegistry,
  project: string | null,
  fingerprint: string | null,
): (...args: any[]) => Promise<unknown> {
  return async (args) => {
    const ctx: HookContext = {
      toolName,
      args,
      toolType: "server",
      project,
      fingerprint,
    };

    // PreToolUse — can deny or modify
    const preResult = await registry.runPreHooks(ctx);
    if (preResult.action === "deny") {
      return { error: preResult.reason, blocked: true };
    }
    const finalArgs = preResult.action === "modify"
      ? preResult.args : args;

    // Execute original
    const start = Date.now();
    const result = await originalExecute(finalArgs);
    const durationMs = Date.now() - start;

    // PostToolUse — fire and forget
    registry.runPostHooks({ ...ctx, args: finalArgs, result, durationMs })
      .catch(err => log.error({ err }, "post-hook error"));

    return result;
  };
}
```

### Client tools: stream interception

In the stream processor, before emitting a tool-call chunk for a client tool:

```typescript
if (part.type === "tool-call" && !SERVER_TOOL_NAMES.has(part.toolName)) {
  const ctx: HookContext = {
    toolName: part.toolName,
    args: part.args,
    toolType: "client",
    project,
    fingerprint,
  };

  const preResult = await registry.runPreHooks(ctx);
  if (preResult.action === "deny") {
    // Emit a denial as a tool-result so the model course-corrects
    emitToolResult(part.toolCallId, part.toolName, {
      error: preResult.reason,
      blocked: true,
    });
    continue;
  }
}
```

The challenge: the AI SDK's fullStream is an async iterable consumed
linearly. Injecting a synthetic tool-result mid-stream requires a
transformer that can buffer tool-call events, run hooks, and either
forward the event or inject a denial.

Approach: wrap the fullStream in an async generator that acts as a
filtering transform. The stream processor already iterates over events —
this adds one layer of indirection.

```typescript
async function* hookFilteredStream(
  stream: AsyncIterable<StreamPart>,
  registry: HookRegistry,
  ctx: { project: string | null; fingerprint: string | null },
): AsyncIterable<StreamPart> {
  for await (const part of stream) {
    if (part.type === "tool-call" && !SERVER_TOOL_NAMES.has(part.toolName)) {
      const hookCtx = { ...ctx, toolName: part.toolName, args: part.args, toolType: "client" as const };
      const result = await registry.runPreHooks(hookCtx);
      if (result.action === "deny") {
        // Yield a synthetic tool-result instead of the tool-call
        yield {
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: { error: result.reason, blocked: true },
        };
        continue;
      }
    }
    yield part;
  }
}
```

## Approval Flow

When a PreToolUse hook denies an action, the model should present the
action to the developer and ask for approval. If the developer approves,
the model re-attempts the tool call — but the hook would deny it again
without an approval mechanism.

### Session-Scoped Approval Tracker

```typescript
interface ApprovalTracker {
  /** Record an approval for a specific action */
  approve(key: string, fingerprint: string): void;

  /** Check if an action has been approved */
  isApproved(key: string, fingerprint: string): boolean;

  /** Clear all approvals for a conversation */
  clear(fingerprint: string): void;
}
```

Approval keys are generated from the tool name + a normalized form of the
dangerous argument pattern. Example: `bash:git push --force` maps to key
`bash:git_push_force`.

The destructive action guard checks the tracker before denying:
```typescript
if (matchesDestructivePattern(ctx)) {
  const key = approvalKey(ctx.toolName, ctx.args);
  if (tracker.isApproved(key, ctx.fingerprint)) {
    return { action: "allow" };
  }
  return { action: "deny", reason: "..." };
}
```

The approval gets recorded when the model's next message includes the
action and the developer's response confirms it. This requires parsing
the conversation — the simplest approach is a dedicated tool:

```typescript
// Server tool: request_approval
// The model calls this when it needs to do something destructive
const requestApproval = tool({
  description: "Request developer approval for a destructive or irreversible action.",
  inputSchema: z.object({
    action: z.string().describe("Description of the action needing approval"),
    command: z.string().describe("The exact command or tool call to execute"),
  }),
  execute: async ({ action, command }) => {
    // This tool has no execute — it's a client tool that shows
    // a confirmation prompt in the editor/terminal UI.
    // When approved, the approval tracker records it.
  },
});
```

Alternatively, the simpler approach: the destructive guard's denial
message tells the model to ask the developer. The developer's approval
is a regular message. The next time the model attempts the same action,
the hook checks whether the last user message was an approval. This is
fuzzier but requires no new tools.

## Configuration

```typescript
// In config.ts
hooks: {
  /** Enable the destructive action guard (default: true) */
  destructiveGuard: Bun.env.HOOKS_DESTRUCTIVE_GUARD !== "false",
  /** Enable the tool hierarchy enforcer (default: true) */
  hierarchyEnforcer: Bun.env.HOOKS_HIERARCHY_ENFORCER !== "false",
  /** Enable the audit logger (default: true) */
  auditLog: Bun.env.HOOKS_AUDIT_LOG !== "false",
  /** Enable Cartographer post-edit trigger (default: true) */
  cartographerTrigger: Bun.env.HOOKS_CARTOGRAPHER_TRIGGER !== "false",
  /** Enable background task auto-detection (default: true) */
  backgroundTaskManager: Bun.env.HOOKS_BACKGROUND_TASKS !== "false",
},
```

## File Structure

```
src/hooks/
  types.ts          — Hook interfaces, HookContext, PreToolUseResult
  registry.ts       — HookRegistry class, execution logic
  approval.ts       — Session-scoped approval tracker
  task-tracker.ts   — Background task tracking (in-memory store + completion checks)
  built-in/
    destructive.ts  — Destructive action guard
    hierarchy.ts    — Tool hierarchy enforcer
    background.ts   — Background task manager (auto-detect + log + track)
    cartographer.ts — Post-edit Cartographer trigger
    audit.ts        — Audit logger
  index.ts          — Create registry, register built-ins, export singleton
```

## Cartographer & Goldfish Refactoring

The hooks system enables a clean separation between automatic behaviors
(harness-driven, structurally guaranteed) and explicit tools (model-initiated,
for targeted queries). This reduces the tool count the model has to think
about and eliminates reliance on prompt instructions for session management.

### Current State (before hooks)

Three overlapping layers:

1. **Automatic in `prepareAgent()`** — `retrieveMemories()` fetches Goldfish
   memories and injects them into the dynamic system prompt. `extractAndStoreMemories()`
   runs after each response.
2. **System prompt instructions** — `<session_management>` tells the model to
   query Goldfish, check Cartographer index status, and load rules at session
   start. The model may or may not follow this.
3. **Explicit server tools** — 5 memory tools + 4 Cartographer tools that the
   model calls during the agent loop. The model has to remember which to use
   when, and the session start ritual is a prompt-level instruction rather
   than a guarantee.

### Target State (with hooks)

**Automatic → Lifecycle hooks (model doesn't think about it):**

| Behavior | Current | With Hooks |
|----------|---------|------------|
| Memory retrieval on request | `retrieveMemories()` in `prepareAgent()` | Same — keep as-is |
| Memory extraction post-response | `extractAndStoreMemories()` fire-and-forget | Same — keep as-is |
| Cartographer index status check | Prompt instruction (unreliable) | `session_start` lifecycle hook |
| Project rules loading | Prompt instruction (unreliable) | `session_start` lifecycle hook |
| Project resolution | Model calls `cartographer_list_projects` | `session_start` lifecycle hook |
| Cartographer re-index after edits | Prompt instruction (unreliable) | `PostToolUse` hook on write/edit |

**Explicit → Keep as tools (model calls for targeted queries):**

| Tool | Purpose | Keep? |
|------|---------|-------|
| `memory_search` | Targeted queries beyond automatic retrieval | Yes |
| `memory_store` | Model decides what to persist explicitly | Yes |
| `memory_update` | Update existing memory content | Yes |
| `memory_list` | Review stored memories | Yes |
| `memory_delete` | Remove a memory (with confirmation) | Yes |
| `cartographer_search` | Find files/symbols in the codebase | Yes |
| `cartographer_file_info` | File details, imports, dependents | Yes |
| `cartographer_query` | Walk the import graph from entry points | Yes |
| `cartographer_list_projects` | List indexed projects | Drop — lifecycle hook handles it |

### Session Start Lifecycle Hook

The `session_start` lifecycle hook runs once per conversation (first request
with a new fingerprint) and does:

1. **Resolve project** — Query Cartographer for indexed projects. If exactly
   one, use it. If multiple, pick the one matching the client's working
   directory (from Zed's system message). Store the resolved project in
   session state so all subsequent tool calls can auto-resolve.

2. **Check index status** — Query Cartographer for file count in the resolved
   project. If zero, warn the model that structural queries won't work until
   the project is indexed. Inject the result into the dynamic system prompt.

3. **Load project rules** — Query Cartographer for rules files (CLAUDE.md,
   AGENTS.md, .claude/rules/) in the resolved project. Inject the rules
   content into the dynamic system prompt so the model sees them as part of
   its operating context, not as a tool result it has to remember.

The results are injected into `buildDynamicContent()` in `system-prompt.ts`:

```typescript
function buildDynamicContent(
  projectPath?: string | null,
  memories?: string | null,
  sessionContext?: SessionContext | null,  // ← new
): string {
  // ... existing date/time/project ...

  if (sessionContext?.rules) {
    parts.push(`<project_rules>\n${sessionContext.rules}\n</project_rules>`);
  }

  if (sessionContext?.indexStatus) {
    parts.push(`<codebase_status>\n${sessionContext.indexStatus}\n</codebase_status>`);
  }

  if (memories) {
    parts.push(`<memories>\n${memories}\n</memories>`);
  }

  return parts.join("\n\n");
}
```

### Post-Edit Cartographer Hook

A `PostToolUse` hook registered for client write/edit tools:

```typescript
registry.onPostToolUse(async (ctx) => {
  const filePath = ctx.args.path as string;
  if (!filePath) return;

  // Re-index the modified file in Cartographer
  const db = await getDb();
  // Trigger incremental re-index for this file path
  // (requires Cartographer to expose an update-single-file API,
  // or we shell out to the cartographer CLI)
}, {
  names: ["write", "edit", "create"],
  type: "client",
});
```

Open question: Cartographer is currently an external process (Rust binary)
that indexes on its own schedule. The PostToolUse hook needs either:
- A Cartographer HTTP API for incremental re-index (ideal)
- A CLI command to trigger re-index of a single file
- Direct SurrealDB writes to update the file's entry (fragile, bypasses
  Tree-sitter parsing)

The first option is cleanest. Worth adding to Cartographer's roadmap.

### System Prompt Changes

The `<session_management>` section shrinks:

```xml
<session_management>
Session start is handled automatically by the harness: project resolution,
Cartographer index status, project rules, and memory retrieval are all
injected into context before Mimir's first turn.

Ongoing: When the developer makes decisions about architecture, conventions,
patterns, or approaches, Mimir persists these to Goldfish (memory_store)
so they are available in future sessions.

Context management: Mimir monitors its context window utilization. When
context approaches capacity, Mimir persists a session summary to Goldfish
before the context is lost, ensuring continuity across sessions.
</session_management>
```

The `<tool_hierarchy_enforcement>` in Required Patterns also simplifies —
the "before beginning work, check Goldfish and Cartographer" instruction
becomes less critical since the lifecycle hook already injected that context.
Keep it as a reminder for mid-session queries, but it's no longer the
primary mechanism.

### Migration Path

1. Build the lifecycle hook infrastructure (registry + types)
2. Implement `session_start` hook with project resolution + rules loading
3. Move rules injection from model-initiated `cartographer_rules` call to
   automatic injection in `buildDynamicContent()`
4. Drop `cartographer_list_projects` from the server tool set
5. Update system prompt `<session_management>` section
6. Implement PostToolUse hook for Cartographer re-index (depends on
   Cartographer exposing an incremental update API)

## Implementation Progress

### Phase 1: Core infrastructure — COMPLETE
1. ✅ **types.ts + registry.ts** — Hook interfaces, registry class, execution logic.
2. ✅ **Server tool wrapping in buildTools()** — `wrapToolsWithHooks()` in agent.ts, passes `availableTools` context.
3. ✅ **audit.ts** — PostToolUse timing logger.
4. ✅ **hooks/index.ts** — Singleton registry, ordered built-in registration.
5. ✅ **config.ts hooks section** — Feature flags for all built-in hooks.
6. ✅ **Test infrastructure** — bunfig.toml preload, logger mock, bun test script.

### Phase 2: Safety hooks — COMPLETE (except background task manager)
7. ✅ **destructive.ts** — 14 patterns, per-registration DenialTracker, escalation after 3 retries.
8. ✅ **hierarchy.ts** — 5 substitution categories, only fires when dedicated tool available.
9. ✅ **denial-tracker.ts** — Conversation-scoped consecutive denial counting, threshold escalation, prune.
10. ✅ **Tests** — 71 tests passing: registry (13), denial-tracker (10), destructive (20), hierarchy (18), prune (10).
    Updated: ~120 tests total with task-tracker (14) and background (49) tests added in Phase 2b.

### Phase 2b: Background task manager — COMPLETE
11. ✅ **task-tracker.ts** — In-memory store, log-tail completion scanning, singleton via getTaskTracker().
12. ✅ **background.ts** — 17 patterns (install-first ordering), PreToolUse rewrite + PostToolUse registration + result annotation.
13. ✅ **Background task context injection** — taskTracker.snapshot() in prepareAgent(),
    buildDynamicContent() renders `<background_tasks>` block, pruneCompleted() on each request.

### Phase 3: Session lifecycle + refactoring — COMPLETE
14. ✅ **Lifecycle hook infrastructure** — session_start emitted in prepareAgent() for new
    fingerprints, compaction_triggered emitted in updateAfterResponse() when flagging.
15. ✅ **Session start hook** — SessionStore + resolveSessionContext() auto-resolves project
    from Cartographer DB, checks index status, loads rules (CLAUDE.md, AGENTS.md,
    .claude/rules/*.md) from project root with graceful fallback.
16. ✅ **buildDynamicContent() refactor** — Accepts DynamicContentOptions object with project,
    memories, rules, indexStatus, backgroundTasks. Renders `<project_rules>` and
    `<codebase_status>` blocks in the dynamic system prompt.
17. ✅ **Drop cartographer_list_projects** — Removed from cartographerTools. Project resolution
    handled by session_start lifecycle hook.
18. ✅ **Update system prompt** — Shrunk `<session_management>` to note automatic injection.
    Removed cartographer_list_projects and cartographer_rules from tool descriptions.
    Cartographer description notes that project/rules/index are auto-injected.

### Phase 4: Advanced — COMPLETE
19. ✅ **Client tool stream interception** — Inline hook check in processStream's client
    tool-call branch. Denied tool-calls emitted as visible text (⛔ blocked), not as
    tool_calls. Modified args (e.g. background task rewrite) flow through to the emitted
    tool_call. hookContext (project, fingerprint, availableTools) threaded from agent
    through streaming handler to stream processor.
20. ✅ **approval.ts** — ApprovalTracker with global fallback for isApproved() (server tool
    execute has no hook context). approve_action server tool records approvals. Destructive
    guard checks tracker before denying, clears denial counter on approved retry.
21. ✅ **Cartographer post-edit hook** — PostToolUse hook on client write/edit/create/delete
    tools. Invalidates cart_file + cart_import entries in SurrealDB so Cartographer's next
    indexing pass re-processes the file. No Rust changes needed.
22. N/A **Cartographer incremental API** — Superseded by item 21's invalidation approach.
    A proper incremental re-index API from the Rust binary would be faster but is not
    required for correctness.

### Also completed this session (non-hooks)
- ✅ **system-prompt.md** — Full rewrite with XML tags, positive framing, Claude Code patterns,
  planning gate, action safety, LSP diagnostics, comment discipline, verification,
  long-running tasks, tool substitutions, assertiveness, faithful reporting, failure diagnosis.
- ✅ **mimir-assistant.md** — PA prompt with matching improvements.
- ✅ **Tool result pruning** — `prune.ts` pure function, wired into prepareAgent(),
  configurable via `CONTEXT_KEEP_RECENT_TOOL_RESULTS` (default 20).

## Open Questions

1. **Denied tool calls and MAX_AGENT_STEPS** — Denied calls should NOT count
   against the step limit. The step budget exists to cap actual work, not to
   penalize the safety system working correctly. A denial consumes no real
   compute — the model tried, the harness caught it, no work happened.
   Burning step budget on denials means the developer loses capacity on the
   real task because the guardrails fired. Instead, use a separate **consecutive
   denial counter**: if the model retries the same denied action 3 times
   without asking the developer, break the loop and escalate. This requires
   either customizing the AI SDK's step counting or tracking denials outside
   the SDK's loop and injecting a hard stop message.

2. **Client tool stream injection** — The async generator transform approach
   looks clean in theory. Need to prototype and verify it works with AI SDK's
   fullStream event types without breaking the stream processor's expectations.

3. **Approval persistence** — Should approvals survive across requests within
   the same conversation? Yes (session-scoped). Should they survive across
   sessions? No. In-memory Map keyed by fingerprint is sufficient.

4. **PostToolUse result transformation** — RESOLVED: Implemented option (a).
   PostToolUse hooks can return `{ result }` to modify what the model sees.
   The registry's `runPostHooks()` chains modifications cumulatively.
   `wrapToolsWithHooks()` in agent.ts uses the final result from post-hooks.
   Background task manager (Phase 2b) will use this to append monitoring info.

5. **User-defined hooks** — The `customHooksPath` config is powerful but
   introduces code execution from user config. For v1, only support the
   built-in hooks. User-defined hooks via a pattern-based config format
   (JSON/YAML rules) is a safer v2 approach.

6. **Testing** — RESOLVED: 71 tests across 5 files. Registry tests cover
   execution order, deny short-circuit, modify cumulation, filter matching,
   and error recovery. Each built-in hook has dedicated tests with fixture
   tool calls. Test infrastructure uses bunfig.toml preload with pino mock.
