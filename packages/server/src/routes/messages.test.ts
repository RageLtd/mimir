/**
 * Persist endpoint BYOK transport tests (MIM-74). Persistence, project
 * resolution, and post-processing are mocked — these tests pin the route's
 * key transport contract: X-Provider-Api-Key header + body provider /
 * small_model hints become the extraction's override; keyless POSTs pass
 * null and stay on the env path.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const extractSpy = mock(() => {});
mock.module("../agent/post-processing", () => ({
  extractMemoriesFromResponse: extractSpy,
}));

mock.module("../agent/message-log/persistence", () => ({
  appendTurn: mock(async () => ["id-1", "id-2"]),
}));

mock.module("../projects/store", () => ({
  ensureProjectId: mock(async () => "proj-uuid"),
}));

import { messages } from "./messages";

const persistBody = (extra: Record<string, unknown> = {}) => ({
  messages: [
    { role: "user", content: "a real question with substance" },
    { role: "assistant", content: "a real answer with substance" },
  ],
  project: "/repo",
  ...extra,
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  messages.request("/persist", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("POST /persist BYOK transport (MIM-74)", () => {
  beforeEach(() => {
    extractSpy.mockClear();
  });

  test("header + body hints reach the spawned extraction as an override", async () => {
    const res = await post(
      persistBody({ provider: "anthropic", small_model: "anthropic/haiku" }),
      { "X-Provider-Api-Key": "sk-cc-user" },
    );
    expect(res.status).toBe(200);

    expect(extractSpy).toHaveBeenCalledWith(
      "a real answer with substance",
      expect.objectContaining({ role: "user" }),
      "proj-uuid",
      "owner",
      {
        override: {
          apiKey: "sk-cc-user",
          provider: "anthropic",
          smallModel: "anthropic/haiku",
        },
      },
    );
  });

  test("keyless persist passes null — env small model path", async () => {
    const res = await post(persistBody());
    expect(res.status).toBe(200);

    expect(extractSpy).toHaveBeenCalledWith(
      "a real answer with substance",
      expect.objectContaining({ role: "user" }),
      "proj-uuid",
      "owner",
      null,
    );
  });

  test("body hints without the key header are ignored — key is the gate", async () => {
    const res = await post(persistBody({ small_model: "anthropic/haiku" }));
    expect(res.status).toBe(200);

    expect(extractSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      "proj-uuid",
      "owner",
      null,
    );
  });
});
