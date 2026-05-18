import { describe, expect, test } from "bun:test";
import type { SessionState } from "../../agent/types";
import { createAnchorState } from "../claude-code/voice-anchors";
import type { BackendEvent, BackendRunOptions } from "../types";
import { createCodexBackend } from "./adapter";

const createSession = (): SessionState => ({
  sessionId: "session_1",
  messages: [],
  projectPath: "/Users/rageltd/Projects/mimir",
  projectId: null,
  projectInfo: null,
  abortController: null,
  currentModelId: "codex/gpt-5.5",
  currentMode: "default",
  title: null,
  projectRules: null,
  rules: [],
  clientMcp: null,
  clientCapabilities: {},
  voiceAnchors: createAnchorState("session_1", 0),
  bootSequenceDone: false,
  permanentlyAllowedTools: new Set(),
  ccQuery: null,
  ccUserStreamPush: null,
  ccEvents: null,
  ccQueryConfig: null,
  codexAppServer: null,
  codexInstructionPath: "/tmp/mimir-codex-instructions/session_1.md",
  codexThreadConfig: null,
});

const createRunOptions = (session: SessionState): BackendRunOptions => ({
  prompt: "Fix Codex streaming.",
  systemPrompt: "",
  messages: session.messages,
  tools: [],
  projectPath: session.projectPath,
  metadata: {},
  modelId: session.currentModelId,
  effort: "high",
  session,
});

const collectEvents = async (iter: AsyncGenerator<BackendEvent>) => {
  const events: BackendEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
};

describe("Codex backend adapter", () => {
  test("uses an app-server session when available and streams turn events through it", async () => {
    const startCalls: unknown[] = [];
    const turnCalls: unknown[] = [];
    const backend = createCodexBackend({
      serverUrl: "http://mimir.conhost.lan",
      userMemoryDbPath: "/tmp/user-memory.db",
      defaultCwd: "/Users/rageltd/Projects/mimir",
      appServer: {
        async start(options, _approvalHandler) {
          startCalls.push(options);
          return {
            threadId: "thread_1",
            async close() {},
            async *runTurn(options) {
              turnCalls.push(options);
              yield { type: "text", text: "Hello" } satisfies BackendEvent;
              yield { type: "finish" } satisfies BackendEvent;
            },
          };
        },
      },
    });
    const session = createSession();

    const events = await collectEvents(backend.run(createRunOptions(session)));

    expect(events).toEqual([
      { type: "text", text: "Hello" },
      { type: "finish" },
    ]);
    expect(startCalls).toHaveLength(1);
    expect(turnCalls).toEqual([
      {
        prompt: "Fix Codex streaming.",
        model: "gpt-5.5",
        effort: "high",
        signal: undefined,
      },
    ]);
    expect(session.codexAppServer?.threadId).toBe("thread_1");
  });
});
