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
      keepRecentToolResults: 20,
      responseReserve: 8192,
    },
    hooks: {
      auditLog: false,
      destructiveGuard: false,
      hierarchyEnforcer: false,
      backgroundTaskManager: false,
      cartographerTrigger: false,
      flailingDetection: false,
    },
    flailing: {
      nudgeThreshold: 0.6,
      maxNudges: 4,
      windowSize: 20,
    },
    smallModel: {
      baseUrl: "http://localhost:11434",
      apiKey: "",
      model: "qwen3.5:9b",
      providerType: "ollama",
    },
  },
}));

// Mock provider-registry - this is what summarizeConversation uses now
mock.module("./provider-registry", () => ({
  getProviderConfigForModel: () => ({
    baseUrl: "https://api.test.com",
    apiKey: "test-key",
  }),
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
    mockFetch.mockClear();
    mockEmbedOne.mockClear();
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
        project: "global",
      }),
    );
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