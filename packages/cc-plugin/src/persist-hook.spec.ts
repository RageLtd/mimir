/**
 * Tests for persistPlan: the pure decision behind the two-phase `persist`
 * run (MIM-134). BYOK configured runs today's path; unconfigured, phase one
 * asks the hooks module for a `facts` completion and phase two parses what
 * came back.
 */

import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  buildExtractionText,
  type ExtractionConfig,
  prepareExtraction,
} from "@mimir/plugin-core/brain/extract";
import { persistPlan } from "./persist-hook";

const BYOK: ExtractionConfig = {
  baseUrl: "http://localhost:11434/v1",
  model: "llama3",
};

const user = (content: string): ModelMessage => ({ role: "user", content });
const assistant = (content: string): ModelMessage => ({
  role: "assistant",
  content,
});

// Two user turns and well over the 200 rendered chars the extraction gate needs.
const LONG: ModelMessage[] = [
  user(
    "We decided the sync relay stays blind: the server never parses memory content, only ciphertext.",
  ),
  assistant(
    "Understood. Extraction and embeddings therefore run client-side, and the server only distributes wrapped keys.",
  ),
  user(
    "Right, and the cc-plugin should use Haiku through the session's own client when no endpoint is configured.",
  ),
  assistant(
    "Noted: a configured extraction endpoint and model win when present; otherwise Haiku via the session client.",
  ),
];

// One user turn: the extraction gate skips.
const SHORT: ModelMessage[] = [user("hi")];

describe("persistPlan", () => {
  test("BYOK configured runs today's path", () => {
    expect(persistPlan({ messages: LONG, extraction: BYOK })).toEqual({
      kind: "byok",
    });
  });

  test("BYOK configured runs today's path even when completions arrive", () => {
    expect(
      persistPlan({
        messages: LONG,
        extraction: BYOK,
        completions: { facts: { text: '["a"]' } },
      }),
    ).toEqual({ kind: "byok" });
  });

  test("unconfigured, a gate skip settles with the skip reason", () => {
    const prepared = prepareExtraction(SHORT);
    if (!("skipped" in prepared)) {
      throw new Error("fixture should fail the extraction gate");
    }
    expect(persistPlan({ messages: SHORT, extraction: null })).toEqual({
      kind: "settle",
      advance: true,
      reason: prepared.skipped,
    });
  });

  test("unconfigured, a passing gate requests a facts completion carrying the extraction prompts", () => {
    const plan = persistPlan({ messages: LONG, extraction: null });
    if (plan.kind !== "request") {
      throw new Error(`expected a request, got ${JSON.stringify(plan)}`);
    }
    expect(Object.keys(plan.requests)).toEqual(["facts"]);
    expect(plan.requests.facts.system).toContain(
      "You extract factual memories",
    );
    expect(plan.requests.facts.prompt).toBe(buildExtractionText(LONG));
    expect(plan.requests.facts.maxTokens).toBeGreaterThan(0);
  });

  test("unconfigured, a facts completion with a string array stores the parsed memories", () => {
    expect(
      persistPlan({
        messages: LONG,
        extraction: null,
        completions: { facts: { text: '["a","b"]' } },
      }),
    ).toEqual({ kind: "store", memories: ["a", "b"] });
  });

  test("unconfigured, an unparseable facts completion retries", () => {
    const plan = persistPlan({
      messages: LONG,
      extraction: null,
      completions: { facts: { text: "not json" } },
    });
    if (plan.kind !== "retry") {
      throw new Error(`expected a retry, got ${JSON.stringify(plan)}`);
    }
    expect(typeof plan.reason).toBe("string");
    expect(plan.reason.length).toBeGreaterThan(0);
  });

  test("unconfigured, a failed facts completion retries naming the error", () => {
    const plan = persistPlan({
      messages: LONG,
      extraction: null,
      completions: { facts: { error: "api-error" } },
    });
    if (plan.kind !== "retry") {
      throw new Error(`expected a retry, got ${JSON.stringify(plan)}`);
    }
    expect(plan.reason).toContain("api-error");
  });

  test("unconfigured, completions without a facts key retry", () => {
    const plan = persistPlan({
      messages: LONG,
      extraction: null,
      completions: {},
    });
    if (plan.kind !== "retry") {
      throw new Error(`expected a retry, got ${JSON.stringify(plan)}`);
    }
    expect(plan.reason.length).toBeGreaterThan(0);
  });
});
