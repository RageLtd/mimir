import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks - MUST be at top level before imports
// ---------------------------------------------------------------------------

const mockGetCompactionState = mock<() => Promise<unknown>>(() =>
  Promise.resolve(null),
);
const mockStartCompaction = mock<() => Promise<boolean>>(() =>
  Promise.resolve(true),
);
const mockFinishCompaction = mock<() => Promise<void>>(() =>
  Promise.resolve(),
);
const mockGetMessagesSince = mock<() => Promise<unknown[]>>(() =>
  Promise.resolve([]),
);
const mockStoreMemory = mock<() => Promise<string | null>>(() =>
  Promise.resolve(null),
);
const mockGetLastSummaries = mock<() => Promise<unknown[]>>(() =>
  Promise.resolve([]),
);

// Mock the specific submodules that compaction.ts imports (not the barrel)
mock.module("./message-log/compaction-state", () => ({
  getCompactionState: mockGetCompactionState,
  startCompaction: mockStartCompaction,
  finishCompaction: mockFinishCompaction,
}));

mock.module("./message-log/persistence", () => ({
  getModelMessagesSince: mockGetMessagesSince,
}));

mock.module("../goldfish/store", () => ({
  storeMemory: mockStoreMemory,
  getLastSummaries: mockGetLastSummaries,
}));

// Mock embedOne from goldfish/clients
const mockEmbedOne = mock<() => Promise<number[] | null>>(() =>
  Promise.resolve(new Array(1024).fill(0.1)),
);

mock.module("../goldfish/clients", () => ({
  embedOne: mockEmbedOne,
}));

// Mock config — must include all sections that transitive imports may read
mock.module("../config", () => ({
  config: {
    context: {
      maxTokens: 262144,
      compactionThreshold: 0.8,
      keepRecentMessages: 50,
      responseReserve: 8192,
    },
    smallModel: {
      baseUrl: "http://localhost:11434",
      apiKey: "",
      model: "qwen3.5:9b",
      providerType: "ollama",
    },
  },
}));

// Mock provider/query - this is what summarizeConversation uses for model resolution
const mockGetSmallModelConfig = mock<() => { baseUrl: string; apiKey: string; model: string } | null>(() => ({
  baseUrl: "http://localhost:11434",
  apiKey: "",
  model: "qwen3.5:9b",
}));

const mockGetProviderConfigForModel = mock<(modelId: string) => { baseUrl: string; apiKey: string } | undefined>(() => ({
  baseUrl: "https://api.test.com",
  apiKey: "test-key",
}));

mock.module("./provider/query", () => ({
  getSmallModelConfig: mockGetSmallModelConfig,
  getProviderConfigForModel: mockGetProviderConfigForModel,
}));

// Mock fetch globally
const mockFetch = mock(() =>
  Promise.resolve({
    json: () =>
      Promise.resolve({
        choices: [{ message: { content: "Summary content" } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
  }),
);

(globalThis as any).fetch = mockFetch;

// Import AFTER mocking
import { runCompaction } from "./compaction";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runCompaction", () => {
  beforeEach(() => {
    mockGetCompactionState.mockClear();
    mockStartCompaction.mockClear();
    mockFinishCompaction.mockClear();
    mockGetMessagesSince.mockClear();
    mockStoreMemory.mockClear();
    mockGetLastSummaries.mockClear();
    mockFetch.mockClear();
    mockEmbedOne.mockClear();
    mockGetSmallModelConfig.mockClear();
    mockGetProviderConfigForModel.mockClear();
  });

  test("does nothing if compaction already in progress", async () => {
    mockStartCompaction.mockResolvedValueOnce(false);

    await runCompaction();

    expect(mockGetMessagesSince).not.toHaveBeenCalled();
    expect(mockStoreMemory).not.toHaveBeenCalled();
  });

  test("skips compaction when insufficient messages", async () => {
    mockStartCompaction.mockResolvedValueOnce(true);
    mockGetCompactionState.mockResolvedValueOnce({
      id: "compaction_state:global",
      tokens_since_last: 250000,
      is_compacting: false,
      last_compaction: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    });
    mockGetMessagesSince.mockResolvedValueOnce([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);

    await runCompaction();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockStoreMemory).not.toHaveBeenCalled();
  });

  test("summarizes and stores when sufficient messages", async () => {
    const messages = Array(15).fill(null).flatMap((_, i) => [
      { role: "user", content: `User message ${i} with enough content to pass filters` },
      { role: "assistant", content: `Assistant response ${i} with sufficient length` },
    ]);

    mockStartCompaction.mockResolvedValueOnce(true);
    mockGetCompactionState.mockResolvedValueOnce({
      id: "compaction_state:global",
      tokens_since_last: 250000,
      is_compacting: false,
      last_compaction: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    });
    mockGetMessagesSince.mockResolvedValueOnce(messages);
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "Compacted summary of conversation" } }],
          usage: { prompt_tokens: 200, completion_tokens: 30 },
        }),
    });
    mockStoreMemory.mockResolvedValueOnce("memory:summary-1");

    await runCompaction();

    expect(mockStoreMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Compacted summary of conversation",
        type: "summary",
      }),
    );
    // Summaries are global — no project_id sentinel on the stored row.
    expect(mockStoreMemory).not.toHaveBeenCalledWith(
      expect.objectContaining({ project_id: expect.anything() }),
    );
  });

  test("uses delta prompt when previous summary exists", async () => {
    const messages = Array(15).fill(null).flatMap((_, i) => [
      { role: "user", content: `User message ${i} with enough content to pass filters` },
      { role: "assistant", content: `Assistant response ${i} with sufficient length` },
    ]);

    mockStartCompaction.mockResolvedValueOnce(true);
    mockGetCompactionState.mockResolvedValueOnce({
      id: "compaction_state:global",
      tokens_since_last: 250000,
      is_compacting: false,
      last_compaction: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    });
    mockGetMessagesSince.mockResolvedValueOnce(messages);
    mockGetLastSummaries.mockResolvedValueOnce([
      { content: "Previous summary content", created_at: "2024-01-01T00:00:00Z" },
    ]);
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "Delta summary" } }],
          usage: { prompt_tokens: 200, completion_tokens: 30 },
        }),
    });
    mockStoreMemory.mockResolvedValueOnce("memory:summary-2");

    await runCompaction();

    // Verify fetch was called with the delta prompt and previous summary in user content
    expect(mockFetch.mock.calls.length).toBeGreaterThan(0);
    const fetchCall = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(fetchCall[1].body as string);
    const systemMsg = body.messages[0].content;
    const userMsg = body.messages[1].content;

    expect(systemMsg).toContain("previous summary already exists");
    expect(userMsg).toContain("<previous_summary>");
    expect(userMsg).toContain("Previous summary content");
    expect(userMsg).toContain("<new_conversation>");
  });

  test("filters out context injection pair from conversation", async () => {
    const messages = [
      // Context injection pair — should be filtered
      { role: "user", content: "Session context:\n<summaries>old stuff</summaries>" },
      { role: "assistant", content: "Understood." },
      // Real conversation — should be kept
      ...Array(15).fill(null).flatMap((_, i) => [
        { role: "user", content: `Real user message ${i} with enough content` },
        { role: "assistant", content: `Real assistant response ${i} with length` },
      ]),
    ];

    mockStartCompaction.mockResolvedValueOnce(true);
    mockGetCompactionState.mockResolvedValueOnce({
      id: "compaction_state:global",
      tokens_since_last: 250000,
      is_compacting: false,
      last_compaction: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    });
    mockGetMessagesSince.mockResolvedValueOnce(messages);
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "Clean summary" } }],
          usage: { prompt_tokens: 200, completion_tokens: 30 },
        }),
    });
    mockStoreMemory.mockResolvedValueOnce("memory:summary-3");

    await runCompaction();

    // Verify the context injection pair was NOT included in the conversation text
    expect(mockFetch.mock.calls.length).toBeGreaterThan(0);
    const fetchCall = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(fetchCall[1].body as string);
    const userMsg = body.messages[1].content;

    expect(userMsg).not.toContain("Session context:");
    expect(userMsg).not.toContain("old stuff");
    expect(userMsg).toContain("Real user message");
  });

  test("uses small model for summarization even when request model is provided", async () => {
    const messages = Array(15).fill(null).flatMap((_, i) => [
      { role: "user", content: `User message ${i} with enough content to pass filters` },
      { role: "assistant", content: `Assistant response ${i} with sufficient length` },
    ]);

    mockStartCompaction.mockResolvedValueOnce(true);
    mockGetCompactionState.mockResolvedValueOnce({
      id: "compaction_state:global",
      tokens_since_last: 250000,
      is_compacting: false,
      last_compaction: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    });
    mockGetMessagesSince.mockResolvedValueOnce(messages);
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "Small model summary" } }],
          usage: { prompt_tokens: 200, completion_tokens: 30 },
        }),
    });
    mockStoreMemory.mockResolvedValueOnce("memory:summary-small");

    // Pass a request model — should still use the small model
    await runCompaction("claude-code/opus");

    const fetchCall = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(fetchCall[1].body as string);

    // Should use the small model, not the request model
    expect(body.model).toBe("qwen3.5:9b");
    // Should hit the small model endpoint, not the request model's provider
    expect(fetchCall[0]).toContain("localhost:11434");
  });

  test("falls back to request model when no small model configured", async () => {
    const messages = Array(15).fill(null).flatMap((_, i) => [
      { role: "user", content: `User message ${i} with enough content to pass filters` },
      { role: "assistant", content: `Assistant response ${i} with sufficient length` },
    ]);

    // Simulate no small model configured
    mockGetSmallModelConfig.mockReturnValueOnce(null);
    mockGetProviderConfigForModel.mockReturnValueOnce({
      baseUrl: "https://vllm.test.com/v1",
      apiKey: "vllm-key",
    });

    mockStartCompaction.mockResolvedValueOnce(true);
    mockGetCompactionState.mockResolvedValueOnce({
      id: "compaction_state:global",
      tokens_since_last: 250000,
      is_compacting: false,
      last_compaction: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    });
    mockGetMessagesSince.mockResolvedValueOnce(messages);
    mockFetch.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "Fallback summary" } }],
          usage: { prompt_tokens: 200, completion_tokens: 30 },
        }),
    });
    mockStoreMemory.mockResolvedValueOnce("memory:summary-fallback");

    await runCompaction("vllm/llama3");

    const fetchCall = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(fetchCall[1].body as string);

    // Should fall back to the request model's provider
    expect(body.model).toBe("llama3");
    expect(fetchCall[0]).toContain("vllm.test.com");
  });

  test("handles summarization failure gracefully", async () => {
    const messages = Array(15).fill(null).flatMap((_, i) => [
      { role: "user", content: `User message ${i} with enough content` },
      { role: "assistant", content: `Assistant response ${i} with length` },
    ]);

    mockStartCompaction.mockResolvedValueOnce(true);
    mockGetCompactionState.mockResolvedValueOnce({
      id: "compaction_state:global",
      tokens_since_last: 250000,
      is_compacting: false,
      last_compaction: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    });
    mockGetMessagesSince.mockResolvedValueOnce(messages);
    mockFetch.mockRejectedValueOnce(new Error("API unavailable"));

    await runCompaction();

    expect(mockStoreMemory).not.toHaveBeenCalled();
    expect(mockFinishCompaction).toHaveBeenCalled();
  });
});