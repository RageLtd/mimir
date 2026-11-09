import type { ModelCompleteResult } from "claude-code";
import { expect, test } from "claude-code/testing";
import {
  completionAsk,
  completionOutcome,
  PERSIST_COMPLETION_TIMEOUT_MS,
  PRECOMPACT_COMPLETION_TIMEOUT_MS,
  parseHookOutput,
} from "./binary";

const REQUEST = { system: "S", prompt: "P", maxTokens: 2048 };
const NO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

test("a two-phase answer exposes its requests", () => {
  const output = parseHookOutput(
    JSON.stringify({ advance: false, requests: { facts: REQUEST } }),
  );

  expect(output.advance).toBe(false);
  expect(output.requests).toEqual({ facts: REQUEST });
});

test("a request becomes a cheap completion with its text verbatim and the leg's deadline", () => {
  const ask = completionAsk(REQUEST, 1234);

  expect(ask.model).toBe("haiku");
  expect(ask.effort).toBe("low");
  expect(ask.system).toBe("S");
  expect(ask.prompt).toBe("P");
  expect(ask.maxTokens).toBe(2048);
  expect(ask.timeoutMs).toBe(1234);
});

test("each leg's completion deadline is a positive integer, persist's the tighter", () => {
  for (const deadline of [
    PERSIST_COMPLETION_TIMEOUT_MS,
    PRECOMPACT_COMPLETION_TIMEOUT_MS,
  ]) {
    expect(Number.isInteger(deadline)).toBe(true);
    expect(deadline).toBeGreaterThan(0);
  }
  expect(PERSIST_COMPLETION_TIMEOUT_MS).toBeLessThan(
    PRECOMPACT_COMPLETION_TIMEOUT_MS,
  );
});

test("an answered completion is its text", () => {
  const result: ModelCompleteResult = {
    isAnswered: true,
    text: '["a fact"]',
    usage: NO_USAGE,
  };

  expect(completionOutcome(result)).toEqual({ text: '["a fact"]' });
});

test("an unanswered completion is its reason, an api error's with its status and detail", () => {
  const unanswered: ModelCompleteResult[] = [
    {
      isAnswered: false,
      reason: "api-error",
      status: 500,
      error: "overloaded",
      usage: NO_USAGE,
    },
    { isAnswered: false, reason: "empty-reply", usage: NO_USAGE },
    { isAnswered: false, reason: "aborted", usage: NO_USAGE },
  ];

  expect(unanswered.map(completionOutcome)).toEqual([
    { error: "api-error 500 overloaded" },
    { error: "empty-reply" },
    { error: "aborted" },
  ]);
});
