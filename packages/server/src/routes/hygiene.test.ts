/**
 * Sweep-trigger BYOK transport tests (MIM-75 Part 1). The sweep itself is
 * mocked — these pin the route's key contract: X-Provider-Api-Key header +
 * body provider/base_url/model hints become the sweep's byok context; a key
 * without a named model is refused (400); keyless POSTs pass byok null and
 * stay on the env path.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const sweepSpy = mock(async () => ({ dryRun: true }));
mock.module("../goldfish/hygiene", () => ({
  runHygieneSweep: sweepSpy,
}));

import { hygiene } from "./hygiene";

const post = (body: unknown, headers: Record<string, string> = {}) =>
  hygiene.request("/sweep", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("POST /sweep BYOK transport (MIM-75)", () => {
  beforeEach(() => {
    sweepSpy.mockClear();
  });

  test("keyless empty body stays on the env path as a dry run", async () => {
    const res = await post(undefined);
    expect(res.status).toBe(200);
    expect(sweepSpy).toHaveBeenCalledWith("owner", {
      dryRun: true,
      byok: null,
    });
  });

  test("a key without a model is refused — hygiene never guesses its judgment model", async () => {
    const res = await post({}, { "X-Provider-Api-Key": "sk-user" });
    expect(res.status).toBe(400);
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  test("header key + body hints reach the sweep as byok context", async () => {
    const res = await post(
      {
        provider: "anthropic",
        base_url: "https://example.test",
        model: "anthropic/claude-sonnet-4-5",
      },
      { "X-Provider-Api-Key": "sk-user" },
    );
    expect(res.status).toBe(200);
    expect(sweepSpy).toHaveBeenCalledWith("owner", {
      dryRun: true,
      byok: {
        override: {
          apiKey: "sk-user",
          provider: "anthropic",
          baseUrl: "https://example.test",
        },
        modelId: "anthropic/claude-sonnet-4-5",
      },
    });
  });

  test("explicit dryRun false arms the sweep", async () => {
    const res = await post({ dryRun: false });
    expect(res.status).toBe(200);
    expect(sweepSpy).toHaveBeenCalledWith("owner", {
      dryRun: false,
      byok: null,
    });
  });

  test("invalid JSON body is a 400, not a sweep", async () => {
    const res = await hygiene.request("/sweep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(sweepSpy).not.toHaveBeenCalled();
  });
});
