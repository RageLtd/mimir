import { embedMany } from "ai";
import { resolveEmbeddingModel } from "../agent/provider-legs";
import { config } from "../config";
import { assertNever } from "../util/assert";
import { log } from "../util/logger";
import { attempt } from "../util/result";
import { cohereEmbed, type EmbedPurpose } from "./embed-cohere";

export type { EmbedPurpose } from "./embed-cohere";

/**
 * Generate embeddings via the configured client (config.embedding.type).
 *
 * `purpose` matters for asymmetric models (Cohere): stored content embeds
 * as "document", retrieval queries as "query". Symmetric models (the
 * OpenAI-compatible path — qwen et al.) ignore it.
 */
export async function embed(
  texts: string[],
  purpose: EmbedPurpose = "document",
) {
  const start = Date.now();
  log.debug(
    {
      count: texts.length,
      totalChars: texts.reduce((a, t) => a + t.length, 0),
      client: config.embedding.type,
      purpose,
    },
    "embedding request",
  );

  switch (config.embedding.type) {
    case "cohere":
      return cohereEmbed(texts, purpose);

    case "openai": {
      // Flatten in case callers pass nested arrays
      const flatTexts = texts.flat() as string[];

      const [err, result] = await attempt(async () =>
        embedMany({
          model: resolveEmbeddingModel(),
          values: flatTexts,
          providerOptions: {
            openaiCompatible: {
              dimensions: config.embedding.dimensions,
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

    default:
      return assertNever(config.embedding.type);
  }
}

/** Embed a single text */
export async function embedOne(
  text: string,
  purpose: EmbedPurpose = "document",
) {
  const result = await embed([text], purpose);
  return result?.[0] ?? null;
}
