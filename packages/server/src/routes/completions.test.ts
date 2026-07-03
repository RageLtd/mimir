/**
 * Tests for the POST /v1/chat/completions route guard.
 *
 * The agent path streams exclusively — the non-streaming JSON builder was
 * removed. A non-streaming agent request (tools present, stream: false) must
 * be rejected with 400 rather than silently handed a stream the caller never
 * asked for. The guard fires after the no-tools utility short-circuit, so it
 * returns before the middleware pipeline runs — no model or context setup
 * needed to exercise it.
 */

import { describe, expect, test } from "bun:test";
import { completions } from "./completions";

const postCompletion = (body: Record<string, unknown>) =>
  completions.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const withTools = {
  model: "test-model",
  messages: [{ role: "user", content: "hi" }],
  tools: [
    {
      type: "function",
      function: { name: "noop", parameters: {} },
    },
  ],
};

describe("POST /v1/chat/completions: non-streaming agent guard", () => {
  test("rejects a non-streaming agent request with 400", async () => {
    const res = await postCompletion({ ...withTools, stream: false });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("stream: true");
  });
});
