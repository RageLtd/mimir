import type { ModelCompleteResult } from "claude-code";
import { expect, test } from "claude-code/testing";
import { completionAsk, completionOutcome, parseHookOutput } from "./binary";

const REQUEST = { system: "S", prompt: "P", maxTokens: 2048 };
const NO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

test("a two-phase answer exposes its requests", async () => {
  const output = parseHookOutput(
    JSON.stringify({ advance: false, requests: { facts: REQUEST } }),
  );

  expect(output.advance).toBe(false);
  expect(output.requests).toEqual({ facts: REQUEST });
});

test("a request becomes a cheap, bounded completion with its text verbatim", async () => {
  const ask = completionAsk(REQUEST);

  expect(ask.model).toBe("haiku");
  expect(ask.effort).toBe("low");
  expect(ask.system).toBe("S");
  expect(ask.prompt).toBe("P");
  expect(ask.maxTokens).toBe(2048);
  expect(Number.isInteger(ask.timeoutMs)).toBe(true);
  expect(ask.timeoutMs).toBeGreaterThan(0);
});

test("an answered completion is its text", async () => {
  const result: ModelCompleteResult = {
    isAnswered: true,
    text: '["a fact"]',
    usage: NO_USAGE,
  };

  expect(completionOutcome(result)).toEqual({ text: '["a fact"]' });
});

test("an unanswered completion is its reason", async () => {
  const unanswered: ModelCompleteResult[] = [
    {
      isAnswered: false,
      reason: "api-error",
      status: 500,
      error: "server_error",
      usage: NO_USAGE,
    },
    { isAnswered: false, reason: "empty-reply", usage: NO_USAGE },
    { isAnswered: false, reason: "aborted", usage: NO_USAGE },
  ];

  expect(unanswered.map(completionOutcome)).toEqual([
    { error: "api-error" },
    { error: "empty-reply" },
    { error: "aborted" },
  ]);
});
