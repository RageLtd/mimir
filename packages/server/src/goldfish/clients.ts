import { embedMany } from "ai";
import {
  getSmallModelConfig,
  resolveEmbeddingModel,
} from "../agent/provider/query";
import { log } from "../util/logger";
import { attempt } from "../util/result";

/**
 * Generate embeddings via AI SDK's embedMany function.
 * Uses the configured embedding provider (OpenAI-compatible endpoint).
 */
export async function embed(texts: string[]): Promise<number[][] | null> {
  const start = Date.now();
  log.debug(
    {
      count: texts.length,
      totalChars: texts.reduce((a, t) => a + t.length, 0),
    },
    "embedding request",
  );

  // Flatten in case callers pass nested arrays
  const flatTexts = texts.flat() as string[];

  const [err, result] = await attempt(async () =>
    embedMany({
      model: resolveEmbeddingModel(),
      values: flatTexts,
      providerOptions: {
        openaiCompatible: {
          dimensions: 1024,
        },
      },
    }),
  );

  if (err) {
    log.error({ err, count: texts.length }, "embedding failed");
    return null;
  }

  log.debug(
    {
      count: result.embeddings.length,
      dims: result.embeddings[0]?.length,
      elapsed: `${Date.now() - start}ms`,
    },
    "embedding complete",
  );
  return result.embeddings;
}

/** Embed a single text */
export async function embedOne(text: string): Promise<number[] | null> {
  const result = await embed([text]);
  return result?.[0] ?? null;
}

/**
 * Extract structured memories from a conversation.
 *
 * Uses a free Zen model (GPT-5 Nano by default) via OpenAI Chat Completions.
 * Falls back gracefully if Zen is unavailable — memories just don't get extracted.
 */
const EXTRACTION_SYSTEM_PROMPT = `You extract factual memories from development conversations. Output ONLY a JSON array of strings. Each memory should be a specific fact useful in FUTURE conversations.

EXTRACT:
- Architecture decisions and system design
- Technology choices and why they were made
- Bugs found and their root causes
- User preferences (coding style, tools, workflow)
- Configuration details (ports, models, settings)
- Project structure and relationships between components

SKIP:
- Greetings and pleasantries
- Raw file listings or directory paths
- Tool invocation details
- Anything only useful in the current session

If the conversation is just a greeting or trivial exchange, return []. But if there is substantive technical content, extract it.

<example>
Input:
user: The gateway service keeps timing out on large queries
assistant: The issue is the request service's default timeout is 30s. For aggregation queries over 1M rows, ClickHouse needs more time. I've set the gateway proxy timeout to 120s and added a per-query timeout parameter.
user: That fixed it, thanks

Output:
["Gateway was timing out on large queries because request service default timeout was 30s", "Gateway proxy timeout increased to 120s with per-query timeout parameter for large ClickHouse aggregations"]
</example>

<example>
Input:
user: Hey, can you look at the project?
assistant: Sure, I see a Rust + TypeScript monorepo with Hono for the gateway and Actix for the request service. ClickHouse is the primary data store.
user: Right, what tools do we use?
assistant: The stack uses cargo-make for task orchestration, Biome for TS linting, and cargo-zigbuild for cross-compilation to Linux musl targets.

Output:
["data-services is a Rust + TypeScript monorepo using Hono (gateway) and Actix (request service)", "ClickHouse is the primary data store", "Build tooling: cargo-make for tasks, Biome for TS linting, cargo-zigbuild for musl cross-compilation"]
</example>

Output format: ["memory 1", "memory 2", ...]
Return [] only if there is genuinely nothing technical or factual to extract.`;

/** OpenAI Chat Completions response shape */
interface ChatCompletionResponse {
  choices: Array<{
    message: { content: string };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

export async function extractMemories(
  conversationText: string,
): Promise<string[]> {
  const start = Date.now();
  log.debug(
    { inputChars: conversationText.length },
    "memory extraction starting",
  );

  // Use the small model config
  const smallModel = getSmallModelConfig();
  if (!smallModel) {
    log.warn("no small model configured — skipping memory extraction");
    return [];
  }

  const { baseUrl, apiKey, model: bareModelId } = smallModel;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // Only add Authorization header if an API key is configured
  // Local APIs (Ollama, vLLM on Tailscale) don't need auth
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const [err, res] = await attempt(() =>
    fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model: bareModelId,
        stream: false,
        temperature: 0.1,
        max_tokens: 2048,
        messages: [
          { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: conversationText },
        ],
      }),
    }).then((r) => r.json() as Promise<ChatCompletionResponse>),
  );

  if (err) {
    log.error(
      { err, inputChars: conversationText.length },
      "memory extraction failed",
    );
    return [];
  }

  const content = res.choices?.[0]?.message?.content?.trim();
  if (!content) {
    log.error("memory extraction returned empty content");
    return [];
  }

  log.debug(
    {
      rawOutput: content,
      promptTokens: res.usage?.prompt_tokens,
      completionTokens: res.usage?.completion_tokens,
      elapsed: `${Date.now() - start}ms`,
    },
    "memory extraction raw result",
  );

  const [parseErr, memories] = await attempt(async () => {
    const cleaned = content.replace(/```json\n?|```/g, "").trim();
    return JSON.parse(cleaned) as string[];
  });

  if (parseErr || !Array.isArray(memories)) {
    log.error({ raw: content, parseErr }, "failed to parse extracted memories");
    return [];
  }

  log.info(
    { count: memories.length, memories, elapsed: `${Date.now() - start}ms` },
    "memories extracted",
  );
  return memories;
}
