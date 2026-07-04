import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

// Fix the embedding config for this file — embed-cohere reads it at call
// time, so the mock governs every test below.
mock.module("../config", () => ({
  config: {
    embedding: {
      type: "cohere",
      baseUrl: "",
      apiKey: "co-test-key",
      model: "embed-v4.0",
      dimensions: 1024,
    },
  },
}));

import { buildEmbedBody, chunkTexts, cohereEmbed } from "./embed-cohere";

afterEach(() => {
  spyOn(globalThis, "fetch").mockRestore();
});

describe("chunkTexts", () => {
  test("splits at the API limit of 96", () => {
    const texts = Array.from({ length: 200 }, (_, i) => `t${i}`);
    const chunks = chunkTexts(texts);
    expect(chunks.map((c) => c.length)).toEqual([96, 96, 8]);
    expect(chunks.flat()).toEqual(texts);
  });

  test("small input → single chunk", () => {
    expect(chunkTexts(["a", "b"])).toEqual([["a", "b"]]);
  });
});

describe("buildEmbedBody", () => {
  test("maps purpose to Cohere input_type and carries output_dimension", () => {
    const doc = buildEmbedBody(["x"], "document");
    expect(doc.model).toBe("embed-v4.0");
    expect(doc.input_type).toBe("search_document");
    expect(doc.output_dimension).toBe(1024);
    expect(doc.embedding_types).toEqual(["float"]);

    const query = buildEmbedBody(["x"], "query");
    expect(query.input_type).toBe("search_query");
  });
});

describe("cohereEmbed", () => {
  const vec = (n: number) => [n, n, n];
  const okResponse = (floats: number[][]) =>
    new Response(
      JSON.stringify({
        embeddings: { float: floats },
        meta: { billed_units: { input_tokens: floats.length } },
      }),
      { status: 200 },
    );

  test("single chunk: embeddings returned in order, auth header sent", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse([vec(1), vec(2)]),
    );

    const result = await cohereEmbed(["a", "b"], "document");

    expect(result).toEqual([vec(1), vec(2)]);
    const init = fetchSpy.mock.calls[0]?.[1];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer co-test-key");
  });

  test("multiple chunks concatenate in input order", async () => {
    const texts = Array.from({ length: 100 }, (_, i) => `t${i}`);
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce(
        okResponse(Array.from({ length: 96 }, (_, i) => vec(i))),
      )
      .mockResolvedValueOnce(
        okResponse(Array.from({ length: 4 }, (_, i) => vec(96 + i))),
      );

    const result = await cohereEmbed(texts, "query");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(100);
    expect(result?.[0]).toEqual(vec(0));
    expect(result?.[99]).toEqual(vec(99));
  });

  test("non-OK response → null", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"message":"invalid api token"}', { status: 401 }),
    );
    expect(await cohereEmbed(["a"], "document")).toBeNull();
  });

  test("embedding count mismatch → null", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(okResponse([vec(1)]));
    expect(await cohereEmbed(["a", "b"], "document")).toBeNull();
  });

  test("empty input → empty output, no call", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse([]),
    );
    expect(await cohereEmbed([], "document")).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
