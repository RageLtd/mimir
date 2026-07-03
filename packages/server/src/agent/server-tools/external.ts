import { tool } from "ai";
import { z } from "zod";
import { config } from "../../config";
import { log } from "../../util/logger";
import { CACHE_CONTROL } from "./shared";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const WebSearchSchema = z.object({
  query: z.string().describe("Search query"),
  max_results: z.number().optional().describe("Maximum results (default: 5)"),
  search_depth: z
    .enum(["basic", "advanced"])
    .optional()
    .describe("'advanced' is slower but more thorough"),
  include_answer: z
    .boolean()
    .optional()
    .describe("Include Tavily summary (default: true)"),
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Tavily client (lazy init) */
let tavilyClient: Awaited<
  ReturnType<typeof import("@tavily/core").tavily>
> | null = null;

async function getTavily() {
  if (!config.tavily.apiKey) return null;
  if (tavilyClient) return tavilyClient;
  const { tavily } = await import("@tavily/core");
  tavilyClient = tavily({ apiKey: config.tavily.apiKey });
  return tavilyClient;
}

// ---------------------------------------------------------------------------
// Execute functions
// ---------------------------------------------------------------------------

export const executeWebSearch = async ({
  query,
  max_results,
  search_depth,
  include_answer,
}: z.infer<typeof WebSearchSchema>) => {
  const tavily = await getTavily();

  if (!tavily) {
    return {
      error: "Web search unavailable — TAVILY_API_KEY not configured",
      answer: null,
      results: [],
    };
  }

  const response = await tavily.search(query, {
    maxResults: max_results ?? 5,
    searchDepth: search_depth ?? "basic",
    includeAnswer: include_answer ?? true,
  });

  const results = response.results.map((searchResult) => ({
    title: searchResult.title,
    url: searchResult.url,
    content: searchResult.content,
    score: searchResult.score,
  }));

  log.info(
    { query, results: results.length, hasAnswer: !!response.answer },
    "web_search",
  );
  return { error: null, answer: response.answer ?? null, results };
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const externalTools = {
  web_search: tool({
    description:
      "Search the web for current information. Use for up-to-date data, news, or recent docs.",
    inputSchema: WebSearchSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeWebSearch,
  }),
};
