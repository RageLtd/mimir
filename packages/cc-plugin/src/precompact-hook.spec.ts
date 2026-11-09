/**
 * Tests for precompactPlan: the pure decision behind the two-phase
 * `precompact` run (MIM-134). Unconfigured, phase one asks for a `summary`
 * and/or `facts` completion (each only when its gate passed); phase two
 * stores what came back. A failed summary means retry; a failed facts
 * completion only loses that window's facts.
 */

import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  buildExtractionText,
  type ExtractionConfig,
  renderConversation,
} from "@mimir/plugin-core/brain/extract";
import { precompactPlan } from "./precompact-hook";

const BYOK: ExtractionConfig = {
  baseUrl: "http://localhost:11434/v1",
  model: "llama3",
};

const user = (content: string): ModelMessage => ({ role: "user", content });
const assistant = (content: string): ModelMessage => ({
  role: "assistant",
  content,
});

/** summarize.ts's render budget (SUMMARIZE_MAX_CHARS, not exported). */
const SUMMARY_RENDER_CHARS = 120_000;

// Two user turns, well over 400 rendered chars: both gates pass.
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

// One short user turn: both gates skip.
const SHORT: ModelMessage[] = [user("hi")];

// Two user turns, between 200 and 400 rendered chars: facts passes, summary skips.
const MID: ModelMessage[] = [user("x".repeat(100)), user("y".repeat(100))];

describe("fixtures", () => {
  test("rendered lengths sit where the gates need them", () => {
    expect(
      renderConversation(LONG, SUMMARY_RENDER_CHARS).length,
    ).toBeGreaterThanOrEqual(400);
    const mid = renderConversation(MID, SUMMARY_RENDER_CHARS).length;
    expect(mid).toBeGreaterThanOrEqual(200);
    expect(mid).toBeLessThan(400);
  });
});

describe("precompactPlan", () => {
  test("BYOK configured runs today's path", () => {
    expect(precompactPlan({ messages: LONG, extraction: BYOK })).toEqual({
      kind: "byok",
    });
  });

  test("BYOK configured runs today's path even when completions arrive", () => {
    expect(
      precompactPlan({
        messages: LONG,
        extraction: BYOK,
        completions: { summary: { text: "A summary." } },
      }),
    ).toEqual({ kind: "byok" });
  });

  test("unconfigured, both gates skipping settles", () => {
    const plan = precompactPlan({ messages: SHORT, extraction: null });
    if (plan.kind !== "settle") {
      throw new Error(`expected a settle, got ${JSON.stringify(plan)}`);
    }
    expect(plan.advance).toBe(true);
    expect(plan.reason.length).toBeGreaterThan(0);
  });

  test("unconfigured, both gates passing requests summary and facts", () => {
    const plan = precompactPlan({ messages: LONG, extraction: null });
    if (plan.kind !== "request") {
      throw new Error(`expected a request, got ${JSON.stringify(plan)}`);
    }
    expect(Object.keys(plan.requests).sort()).toEqual(["facts", "summary"]);
    expect(plan.requests.summary?.system).toContain(
      "You summarize conversations",
    );
    expect(plan.requests.summary?.prompt).toBe(
      renderConversation(LONG, SUMMARY_RENDER_CHARS),
    );
    expect(plan.requests.facts?.system).toContain(
      "You extract factual memories",
    );
    expect(plan.requests.facts?.prompt).toBe(buildExtractionText(LONG));
  });

  test("unconfigured, a window too small to summarise requests facts alone", () => {
    const plan = precompactPlan({ messages: MID, extraction: null });
    if (plan.kind !== "request") {
      throw new Error(`expected a request, got ${JSON.stringify(plan)}`);
    }
    expect(Object.keys(plan.requests)).toEqual(["facts"]);
    expect(plan.requests.facts?.prompt).toBe(buildExtractionText(MID));
  });

  test("unconfigured, both completions succeeding stores both and advances", () => {
    expect(
      precompactPlan({
        messages: LONG,
        extraction: null,
        completions: {
          summary: { text: "A summary." },
          facts: { text: '["x"]' },
        },
      }),
    ).toEqual({
      kind: "store",
      summary: "A summary.",
      memories: ["x"],
      advance: true,
    });
  });

  test("unconfigured, a failed summary stores the facts and does not advance", () => {
    expect(
      precompactPlan({
        messages: LONG,
        extraction: null,
        completions: {
          summary: { error: "api-error" },
          facts: { text: '["x"]' },
        },
      }),
    ).toEqual({
      kind: "store",
      summary: null,
      memories: ["x"],
      advance: false,
    });
  });

  test("unconfigured, a failed facts completion stores the summary and still advances", () => {
    expect(
      precompactPlan({
        messages: LONG,
        extraction: null,
        completions: {
          summary: { text: "A summary." },
          facts: { error: "aborted" },
        },
      }),
    ).toEqual({
      kind: "store",
      summary: "A summary.",
      memories: null,
      advance: true,
    });
  });

  test("unconfigured, an unparseable facts completion stores the summary and still advances", () => {
    expect(
      precompactPlan({
        messages: LONG,
        extraction: null,
        completions: {
          summary: { text: "A summary." },
          facts: { text: "not json" },
        },
      }),
    ).toEqual({
      kind: "store",
      summary: "A summary.",
      memories: null,
      advance: true,
    });
  });

  test("unconfigured, facts alone (summary skipped at phase one) stores the facts and advances", () => {
    expect(
      precompactPlan({
        messages: MID,
        extraction: null,
        completions: { facts: { text: '["x"]' } },
      }),
    ).toEqual({
      kind: "store",
      summary: null,
      memories: ["x"],
      advance: true,
    });
  });
});
