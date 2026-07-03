/** Anthropic cache control for prompt caching on tools */
export const CACHE_CONTROL = {
  anthropic: { cacheControl: { type: "ephemeral" as const } },
};
