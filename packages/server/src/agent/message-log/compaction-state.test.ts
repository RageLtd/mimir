import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as surreal from "../../db/surreal";
import * as providerQuery from "../provider/query";

import { updateTokenCount } from "./index";

// These tests cover the hard cap that prevents Opus' advertised 1M context
// window from delaying compaction until tokens cross the 4x pricing tier.
// The rest of updateTokenCount's behaviour (delta calc, atomic update,
// fallback) lives in message-log.test.ts.

describe("compaction-state cap", () => {
  let queryMock: ReturnType<typeof mock>;
  let queryFirstMock: ReturnType<typeof mock>;

  beforeEach(() => {
    queryMock = mock(() => Promise.resolve([[]]));
    queryFirstMock = mock(() => Promise.resolve(null));

    spyOn(surreal, "getDb").mockImplementation(
      async () => ({ query: queryMock }) as any,
    );
    spyOn(surreal, "queryFirst").mockImplementation(queryFirstMock as any);
  });

  afterEach(() => {
    mock.restore();
  });

  test("caps model window at config.context.maxTokens (Opus 1M cost cliff)", async () => {
    // Opus advertises 1M on some tiers. Without the cap, threshold would be
    // 1M * 0.8 = 800k — deep in the 4x pricing band. With the cap, threshold
    // stays at 262144 * 0.8 ≈ 209715 regardless of what the model claims.
    spyOn(providerQuery, "getContextWindow").mockReturnValue(1_000_000);

    queryFirstMock.mockResolvedValueOnce({
      id: "compaction_state:global",
      tokens_since_last: 220000,
      is_compacting: false,
      last_prompt_tokens: 60000,
      updated_at: "2024-01-01",
    });
    queryFirstMock.mockResolvedValueOnce({
      id: "compaction_state:global",
      tokens_since_last: 221000,
      is_compacting: false,
      last_prompt_tokens: 61000,
      updated_at: "2024-01-01",
    });

    const { needsCompaction } = await updateTokenCount(
      "test-org",
      61000,
      "claude-opus-4-5",
    );

    // 221000 > 209715 — fires. Without the cap it would not fire until
    // tokens_since_last >= 800000.
    expect(needsCompaction).toBe(true);
  });

  test("respects smaller model windows below the cap", async () => {
    // A local model with 128k context should use its own ceiling, not the
    // cap — otherwise compaction wouldn't fire in time for it.
    spyOn(providerQuery, "getContextWindow").mockReturnValue(128_000);

    queryFirstMock.mockResolvedValueOnce({
      id: "compaction_state:global",
      tokens_since_last: 95_000,
      is_compacting: false,
      last_prompt_tokens: 60000,
      updated_at: "2024-01-01",
    });
    queryFirstMock.mockResolvedValueOnce({
      id: "compaction_state:global",
      tokens_since_last: 96_000,
      is_compacting: false,
      last_prompt_tokens: 61000,
      updated_at: "2024-01-01",
    });

    const { needsCompaction } = await updateTokenCount(
      "test-org",
      61000,
      "qwen3-coder:30b",
    );

    // 128k * 0.8 = 102400. 96000 < 102400 — not yet.
    expect(needsCompaction).toBe(false);
  });
});
