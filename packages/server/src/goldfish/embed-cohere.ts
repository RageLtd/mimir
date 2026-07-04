/**
 * Native Cohere /v2/embed client.
 *
 * Deliberately NOT the OpenAI-compat shim and NOT @ai-sdk/cohere: the
 * native API is the only surface that exposes `output_dimension`, which is
 * what lets Cohere cloud embeddings match the self-hosted qwen path at
 * 1024 dims — the HNSW schema stays identical across both deployments.
 * (@ai-sdk/cohere supports inputType/truncate only; the compat shim
 * supports input/model/encoding_format only. Verified against Cohere's
 * v2/embed OpenAPI spec and the AI SDK provider docs, 2026-07.)
 *
 * Also carries `input_type` — embed-v4 is an asymmetric model; documents
 * and retrieval queries embed differently for better retrieval quality.
 */

import { config } from "../config";
import { log } from "../util/logger";
import { attempt } from "../util/result";

const COHERE_EMBED_URL = "https://api.cohere.com/v2/embed";
/** API hard limit: maximum texts per /v2/embed call. */
const MAX_TEXTS_PER_CALL = 96;
const FETCH_TIMEOUT_MS = 30_000;

/** What the text is FOR — maps to Cohere's asymmetric input_type. */
export type EmbedPurpose = "document" | "query";

const INPUT_TYPE: Record<EmbedPurpose, string> = {
  document: "search_document",
  query: "search_query",
};

type CohereEmbedResponse = {
  embeddings?: { float?: number[][] };
  meta?: { billed_units?: { input_tokens?: number } };
};

/** Split texts into API-sized chunks. Exported for tests. */
export const chunkTexts = (
  texts: readonly string[],
  size = MAX_TEXTS_PER_CALL,
) => {
  const chunks: string[][] = [];
  for (let i = 0; i < texts.length; i += size) {
    chunks.push(texts.slice(i, i + size) as string[]);
  }
  return chunks;
};

/** Build one /v2/embed request body. Exported for tests. */
export const buildEmbedBody = (
  texts: readonly string[],
  purpose: EmbedPurpose,
) => ({
  model: config.embedding.model,
  texts,
  input_type: INPUT_TYPE[purpose],
  output_dimension: config.embedding.dimensions,
  embedding_types: ["float"],
});

/**
 * Embed texts via Cohere's native API. Same contract as goldfish/clients'
 * embed(): number[][] on success, null on ANY failure (callers degrade
 * gracefully — retrieval skips, extraction skips).
 */
export async function cohereEmbed(texts: string[], purpose: EmbedPurpose) {
  if (texts.length === 0) return [];
  if (!config.embedding.apiKey) {
    log.error("EMBED_TYPE=cohere but EMBED_API_KEY is unset");
    return null;
  }

  const start = Date.now();
  const all: number[][] = [];
  let billedTokens = 0;

  for (const chunk of chunkTexts(texts)) {
    const [err, res] = await attempt(() =>
      fetch(COHERE_EMBED_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.embedding.apiKey}`,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        body: JSON.stringify(buildEmbedBody(chunk, purpose)),
      }),
    );
    if (err) {
      log.error(
        { err: err.message, count: chunk.length },
        "cohere embed fetch failed",
      );
      return null;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.error(
        { status: res.status, body: body.slice(0, 300) },
        "cohere embed returned error",
      );
      return null;
    }

    const [parseErr, payload] = await attempt(
      () => res.json() as Promise<CohereEmbedResponse>,
    );
    if (parseErr) {
      log.error({ err: parseErr.message }, "cohere embed parse failed");
      return null;
    }

    const floats = payload.embeddings?.float;
    if (!floats || floats.length !== chunk.length) {
      log.error(
        { expected: chunk.length, got: floats?.length ?? 0 },
        "cohere embed returned wrong embedding count",
      );
      return null;
    }
    all.push(...floats);
    billedTokens += payload.meta?.billed_units?.input_tokens ?? 0;
  }

  log.debug(
    {
      count: all.length,
      dims: all[0]?.length,
      purpose,
      billedTokens,
      elapsed: `${Date.now() - start}ms`,
    },
    "cohere embedding complete",
  );
  return all;
}
