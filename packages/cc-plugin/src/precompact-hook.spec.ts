/**
 * Tests for precompactPlan: the pure decision behind the two-phase
 * `precompact` run (MIM-134). Unconfigured with a host that can run
 * completions, phase one asks for a `summary` and/or `facts` completion
 * (each only when its gate passed); phase two stores what came back. A
 * failed summary means retry; a failed facts completion only loses that
 * window's facts. Either failure is reported in the store plan's `reasons`.
 * Unconfigured without such a host keeps the pre-MIM-134 behaviour.
 */

import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  buildExtractionText,
  EXTRACTION_MAX_CHARS,
  type ExtractionConfig,
  renderConversation,
} from "@mimir/plugin-core/brain/extract";
import { SESSION_MODEL_EXTRACTION_CHARS } from "./conversation";
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

const SUMMARY = "A summary.";

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
  test("BYOK configured runs today's path whether or not the host can run completions", () => {
    for (const hostCompletions of [true, false]) {
      expect(
        precompactPlan({ messages: LONG, extraction: BYOK, hostCompletions }),
      ).toEqual({ kind: "byok" });
    }
  });

  test("BYOK configured runs today's path even when completions arrive", () => {
    expect(
      precompactPlan({
        messages: LONG,
        extraction: BYOK,
        hostCompletions: true,
        completions: { summary: { text: SUMMARY } },
      }),
    ).toEqual({ kind: "byok" });
  });

  test("unconfigured, a host that cannot run completions is unconfigured", () => {
    // A module that predates two-phase runs sends no host_completions
    // marker; asking it for requests would leave the delta unsettled forever.
    expect(
      precompactPlan({
        messages: LONG,
        extraction: null,
        hostCompletions: false,
      }),
    ).toEqual({ kind: "unconfigured" });
  });

  test("unconfigured, both gates skipping settles", () => {
    const plan = precompactPlan({
      messages: SHORT,
      extraction: null,
      hostCompletions: true,
    });
    if (plan.kind !== "settle") {
      throw new Error(`expected a settle, got ${JSON.stringify(plan)}`);
    }
    expect(plan.advance).toBe(true);
    expect(plan.reason.length).toBeGreaterThan(0);
  });

  test("unconfigured, both gates passing requests summary and facts", () => {
    const plan = precompactPlan({
      messages: LONG,
      extraction: null,
      hostCompletions: true,
    });
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

  test("unconfigured, the facts request is rendered to the session model's budget", () => {
    const big: ModelMessage[] = [
      user("We decided the sync relay stays blind."),
      assistant("x".repeat(EXTRACTION_MAX_CHARS)),
      user("And the cc-plugin uses Haiku through the session's own client."),
      assistant("y".repeat(EXTRACTION_MAX_CHARS)),
    ];
    const plan = precompactPlan({
      messages: big,
      extraction: null,
      hostCompletions: true,
    });
    if (plan.kind !== "request") {
      throw new Error(`expected a request, got ${JSON.stringify(plan)}`);
    }
    expect(plan.requests.facts?.prompt).toBe(
      buildExtractionText(big, SESSION_MODEL_EXTRACTION_CHARS),
    );
  });

  test("unconfigured, a window too small to summarise requests facts alone", () => {
    const plan = precompactPlan({
      messages: MID,
      extraction: null,
      hostCompletions: true,
    });
    if (plan.kind !== "request") {
      throw new Error(`expected a request, got ${JSON.stringify(plan)}`);
    }
    expect(Object.keys(plan.requests)).toEqual(["facts"]);
    expect(plan.requests.facts?.prompt).toBe(buildExtractionText(MID));
  });

  test("unconfigured, a window with one user turn still requests facts: compaction is its last reading", () => {
    const oneTurn: ModelMessage[] = [
      user("x".repeat(150)),
      assistant("y".repeat(150)),
    ];
    const plan = precompactPlan({
      messages: oneTurn,
      extraction: null,
      hostCompletions: true,
    });
    if (plan.kind !== "request") {
      throw new Error(`expected a request, got ${JSON.stringify(plan)}`);
    }
    expect(Object.keys(plan.requests)).toEqual(["facts"]);
  });

  test("unconfigured, both completions succeeding stores both, advances, and reports no reasons", () => {
    expect(
      precompactPlan({
        messages: LONG,
        extraction: null,
        hostCompletions: true,
        completions: {
          summary: { text: SUMMARY },
          facts: { text: '["x"]' },
        },
      }),
    ).toEqual({
      kind: "store",
      summary: SUMMARY,
      memories: ["x"],
      advance: true,
      reasons: [],
    });
  });

  test("unconfigured, a failed summary stores the facts, does not advance, and reports why", () => {
    expect(
      precompactPlan({
        messages: LONG,
        extraction: null,
        hostCompletions: true,
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
      reasons: [expect.stringContaining("api-error")],
    });
  });

  test("unconfigured, a failed facts completion stores the summary, still advances, and reports why", () => {
    expect(
      precompactPlan({
        messages: LONG,
        extraction: null,
        hostCompletions: true,
        completions: {
          summary: { text: SUMMARY },
          facts: { error: "aborted" },
        },
      }),
    ).toEqual({
      kind: "store",
      summary: SUMMARY,
      memories: null,
      advance: true,
      reasons: [expect.stringContaining("aborted")],
    });
  });

  test("unconfigured, an unparseable facts completion stores the summary, still advances, and reports why", () => {
    const plan = precompactPlan({
      messages: LONG,
      extraction: null,
      hostCompletions: true,
      completions: {
        summary: { text: SUMMARY },
        facts: { text: "not json" },
      },
    });
    expect(plan).toEqual({
      kind: "store",
      summary: SUMMARY,
      memories: null,
      advance: true,
      reasons: [expect.any(String)],
    });
    if (plan.kind !== "store") {
      throw new Error(`expected a store, got ${JSON.stringify(plan)}`);
    }
    expect(plan.reasons[0]?.length).toBeGreaterThan(0);
  });

  test("unconfigured, the summary comes from the whole window though the delta is too small to summarise", () => {
    const plan = precompactPlan({
      messages: SHORT,
      window: LONG,
      extraction: null,
      hostCompletions: true,
    });
    if (plan.kind !== "request") {
      throw new Error(`expected a request, got ${JSON.stringify(plan)}`);
    }
    expect(Object.keys(plan.requests)).toEqual(["summary"]);
    expect(plan.requests.summary?.prompt).toBe(
      renderConversation(LONG, SUMMARY_RENDER_CHARS),
    );
  });

  test("unconfigured, with a window the facts still come from the delta alone", () => {
    const plan = precompactPlan({
      messages: MID,
      window: [...LONG, ...MID],
      extraction: null,
      hostCompletions: true,
    });
    if (plan.kind !== "request") {
      throw new Error(`expected a request, got ${JSON.stringify(plan)}`);
    }
    expect(Object.keys(plan.requests).sort()).toEqual(["facts", "summary"]);
    expect(plan.requests.summary?.prompt).toBe(
      renderConversation([...LONG, ...MID], SUMMARY_RENDER_CHARS),
    );
    expect(plan.requests.facts?.prompt).toBe(buildExtractionText(MID));
  });

  test("unconfigured, an empty delta with a window over the floor still requests the summary", () => {
    const plan = precompactPlan({
      messages: [],
      window: LONG,
      extraction: null,
      hostCompletions: true,
    });
    if (plan.kind !== "request") {
      throw new Error(`expected a request, got ${JSON.stringify(plan)}`);
    }
    expect(Object.keys(plan.requests)).toEqual(["summary"]);
  });

  test("unconfigured, a window too small to summarise is not rescued by a large delta", () => {
    const plan = precompactPlan({
      messages: LONG,
      window: SHORT,
      extraction: null,
      hostCompletions: true,
    });
    if (plan.kind !== "request") {
      throw new Error(`expected a request, got ${JSON.stringify(plan)}`);
    }
    expect(Object.keys(plan.requests)).toEqual(["facts"]);
  });

  test("unconfigured, without a window (an older plugin's payload) the summary comes from the delta", () => {
    const plan = precompactPlan({
      messages: LONG,
      extraction: null,
      hostCompletions: true,
    });
    if (plan.kind !== "request") {
      throw new Error(`expected a request, got ${JSON.stringify(plan)}`);
    }
    expect(plan.requests.summary?.prompt).toBe(
      renderConversation(LONG, SUMMARY_RENDER_CHARS),
    );
  });

  test("unconfigured, phase two with a window and an empty delta stores the summary and advances", () => {
    expect(
      precompactPlan({
        messages: [],
        window: LONG,
        extraction: null,
        hostCompletions: true,
        completions: { summary: { text: SUMMARY } },
      }),
    ).toEqual({
      kind: "store",
      summary: SUMMARY,
      memories: null,
      advance: true,
      reasons: [],
    });
  });

  test("unconfigured, facts alone (summary skipped at phase one) stores the facts, advances, and reports no reasons", () => {
    expect(
      precompactPlan({
        messages: MID,
        extraction: null,
        hostCompletions: true,
        completions: { facts: { text: '["x"]' } },
      }),
    ).toEqual({
      kind: "store",
      summary: null,
      memories: ["x"],
      advance: true,
      reasons: [],
    });
  });
});
