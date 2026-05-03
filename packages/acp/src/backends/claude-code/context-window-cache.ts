/**
 * Per-model context-window cache for the Claude Code backend.
 *
 * Populated lazily after the first SDK turn for a given model: the result
 * message's `modelUsage[*].contextWindow` is the authoritative per-model
 * max (Sonnet 4.5 in 1M mode reports ~1_000_000, Opus reports ~200_000,
 * etc.). The cache lets later emissions — including the initial
 * `usage_update` advertised at session creation/load and the per-turn
 * usage emission in `prompt-cc.ts` — read the real number without holding
 * a long-lived `Query` open just to call `getContextUsage()`.
 *
 * Keyed by the ACP model id (`claude-code/<suffix>`) — the same value
 * that flows through `session.currentModelId`. Lookup is a plain map
 * read; missing keys return `undefined` and the caller decides whether
 * to skip the emission or substitute its own fallback.
 */

const contextWindows = new Map<string, number>();

export const setContextWindow = (modelId: string, size: number) => {
  if (size <= 0) return;
  contextWindows.set(modelId, size);
};

export const getContextWindow = (modelId: string) =>
  contextWindows.get(modelId);

/** Test helper — clears the module-level cache between cases. */
export const resetContextWindowCacheForTests = () => {
  contextWindows.clear();
};
