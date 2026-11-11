/**
 * Tests for persistPlan: the pure decision behind the two-phase `persist`
 * run (MIM-134). BYOK configured runs today's path; unconfigured with a host
 * that can run completions, phase one asks the hooks module for a `facts`
 * completion and phase two parses what came back; unconfigured without one
 * keeps the pre-MIM-134 behaviour.
 */

import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  buildExtractionText,
  EXTRACTION_MAX_CHARS,
  type ExtractionConfig,
  prepareExtraction,
} from "@mimir/plugin-core/brain/extract";
import { SESSION_MODEL_EXTRACTION_CHARS } from "./conversation";
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
  test("BYOK configured runs today's path whether or not the host can run completions", () => {
    for (const hostCompletions of [true, false]) {
      expect(
        persistPlan({ messages: LONG, extraction: BYOK, hostCompletions }),
      ).toEqual({ kind: "byok" });
    }
  });

  test("BYOK configured runs today's path even when completions arrive", () => {
    expect(
      persistPlan({
        messages: LONG,
        extraction: BYOK,
        hostCompletions: true,
        completions: { facts: { text: '["a"]' } },
      }),
    ).toEqual({ kind: "byok" });
  });

  test("unconfigured, a host that cannot run completions is unconfigured", () => {
    // A module that predates two-phase runs sends no host_completions
    // marker; asking it for requests would leave the delta unsettled forever.
    expect(
      persistPlan({ messages: LONG, extraction: null, hostCompletions: false }),
    ).toEqual({ kind: "unconfigured" });
  });

  test("unconfigured, a gate skip carries the delta into the next turn with the skip reason", () => {
    const prepared = prepareExtraction(SHORT);
    if (!("skipped" in prepared)) {
      throw new Error("fixture should fail the extraction gate");
    }
    // A turn is one user message: settling a skip would drop every
    // ordinary turn. Carried, two short turns distil together.
    expect(
      persistPlan({ messages: SHORT, extraction: null, hostCompletions: true }),
    ).toEqual({
      kind: "settle",
      advance: false,
      reason: prepared.skipped,
    });
  });

  test("unconfigured, a stored completion reports the size of the reply it parsed", () => {
    const text = '["the relay stays blind"]';
    expect(
      persistPlan({
        messages: LONG,
        extraction: null,
        hostCompletions: true,
        completions: { facts: { text } },
      }),
    ).toEqual({
      kind: "store",
      memories: ["the relay stays blind"],
      replyChars: text.length,
    });
  });

  test("unconfigured, a passing gate requests a facts completion carrying the extraction prompts", () => {
    const plan = persistPlan({
      messages: LONG,
      extraction: null,
      hostCompletions: true,
    });
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

  test("unconfigured, the session model is handed far more of the delta than an endpoint is", () => {
    // An endpoint's budget is sized for a local reasoning model, whose
    // thinking shares the reply's token limit; the session's model is not.
    const big: ModelMessage[] = [
      user("We decided the sync relay stays blind."),
      assistant("x".repeat(EXTRACTION_MAX_CHARS)),
      user("And the cc-plugin uses Haiku through the session's own client."),
      assistant("y".repeat(EXTRACTION_MAX_CHARS)),
    ];
    const plan = persistPlan({
      messages: big,
      extraction: null,
      hostCompletions: true,
    });
    if (plan.kind !== "request") {
      throw new Error(`expected a request, got ${JSON.stringify(plan)}`);
    }
    expect(plan.requests.facts.prompt).toBe(
      buildExtractionText(big, SESSION_MODEL_EXTRACTION_CHARS),
    );
    expect(plan.requests.facts.prompt.length).toBeGreaterThan(
      EXTRACTION_MAX_CHARS,
    );
  });

  test("unconfigured, a facts completion with a string array stores the parsed memories", () => {
    expect(
      persistPlan({
        messages: LONG,
        extraction: null,
        hostCompletions: true,
        completions: { facts: { text: '["a","b"]' } },
      }),
    ).toEqual({ kind: "store", memories: ["a", "b"], replyChars: 9 });
  });

  test("unconfigured, an unparseable facts completion retries", () => {
    const plan = persistPlan({
      messages: LONG,
      extraction: null,
      hostCompletions: true,
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
      hostCompletions: true,
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
      hostCompletions: true,
      completions: {},
    });
    if (plan.kind !== "retry") {
      throw new Error(`expected a retry, got ${JSON.stringify(plan)}`);
    }
    expect(plan.reason.length).toBeGreaterThan(0);
  });
});
