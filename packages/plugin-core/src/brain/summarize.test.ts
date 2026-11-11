/**
 * Summarizer tests — stub chat endpoint + real replica in a temp dir.
 * Pins: summary stored as type:"summary" with embedding when the embedder
 * answers, unembedded when it doesn't; small windows skip; transport
 * failure stores nothing.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrgReplica } from "../store/org-replica";
import { type ExtractionConfig, renderConversation } from "./extract";
import {
  prepareSummary,
  SUMMARIZE_ELISION_LINE,
  SUMMARIZE_HEAD_CHARS,
  storeSummary,
  summarizeToReplica,
} from "./summarize";

// Stub HTTP round-trips starve under `bun test --parallel`; the runner's 5s
// default is too tight.
setDefaultTimeout(30_000);

let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.MIMIR_HOME;
  process.env.MIMIR_HOME = mkdtempSync(join(tmpdir(), "mimir-summ-test-"));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedHome;
});

const newReplica = () =>
  createOrgReplica(join(process.env.MIMIR_HOME as string, "replica.db"));

const embedNull = async () => null;
const embedFixed = async () => new Array(1024).fill(0.2);

const longWindow = [
  {
    role: "user",
    content: "we spent this session moving extraction client-side ".repeat(8),
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "and the summarizer now writes summary memories locally ".repeat(
          8,
        ),
      },
    ],
  },
];

const withChatStub = async (
  reply: () => Response,
  fn: (config: ExtractionConfig) => Promise<void>,
) => {
  const server = Bun.serve({ port: 0, fetch: () => reply() });
  await fn({
    baseUrl: `http://127.0.0.1:${server.port}`,
    model: "test-model",
  }).finally(() => server.stop(true));
};

const completion = (content: string) =>
  Response.json({ choices: [{ message: { content } }] });

describe("summarizeToReplica", () => {
  test("stores a type:summary memory with embedding and project", async () => {
    const replica = newReplica();
    await withChatStub(
      () => completion("A dense summary of the window."),
      async (config) => {
        const result = await summarizeToReplica({
          config,
          replica,
          messages: longWindow,
          embed: embedFixed,
          projectId: "proj-123",
        });
        expect(result.ok).toBe(true);
        expect(result.id).not.toBeNull();
        const stored = replica.getMemory(result.id as string);
        expect(stored?.type).toBe("summary");
        expect(stored?.content).toBe("A dense summary of the window.");
        expect(stored?.project_id).toBe("proj-123");
        expect(replica.listUnembedded(10)).toEqual([]);
      },
    );
    replica.close();
  });

  test("embedder down → summary still stored, unembedded", async () => {
    const replica = newReplica();
    await withChatStub(
      () => completion("Summary without vectors."),
      async (config) => {
        const result = await summarizeToReplica({
          config,
          replica,
          messages: longWindow,
          embed: embedNull,
        });
        expect(result.ok).toBe(true);
        expect(replica.listUnembedded(10)).toHaveLength(1);
      },
    );
    replica.close();
  });

  test("tiny window skips without a request", async () => {
    const replica = newReplica();
    let hit = false;
    await withChatStub(
      () => {
        hit = true;
        return completion("should not run");
      },
      async (config) => {
        const result = await summarizeToReplica({
          config,
          replica,
          messages: [{ role: "user", content: "hi" }],
          embed: embedNull,
        });
        expect(result.ok).toBe(true);
        expect(result.skipped).toBe("window too small");
        expect(hit).toBe(false);
        expect(replica.countMemories()).toBe(0);
      },
    );
    replica.close();
  });

  test("transport failure stores nothing and reports ok:false", async () => {
    const replica = newReplica();
    const result = await summarizeToReplica({
      config: { baseUrl: "http://127.0.0.1:45991", model: "m" },
      replica,
      messages: longWindow,
      embed: embedNull,
    });
    expect(result.ok).toBe(false);
    expect(replica.countMemories()).toBe(0);
    replica.close();
  });
});

describe("prepareSummary", () => {
  test("tiny window skips", () => {
    expect(prepareSummary([{ role: "user", content: "hi" }])).toEqual({
      skipped: "window too small",
    });
  });

  test("a real window yields the summarization request verbatim", () => {
    const prepared = prepareSummary(longWindow);
    if (!("request" in prepared)) {
      throw new Error(`expected a request, got skip: ${prepared.skipped}`);
    }
    const { request } = prepared;
    expect(request.system).toContain(
      "You summarize conversations into concise context",
    );
    expect(request.prompt).toBe(renderConversation(longWindow, 120_000));
    expect(request.maxTokens).toBe(8192);
    expect(request.prompt).not.toContain(SUMMARIZE_ELISION_LINE);
  });
});

// ── Whole-window summary input: head slice + newest, middle elided ──

const SUMMARY_CAP = 120_000;
const marker = (i: number) => `MSG-${String(i).padStart(3, "0")}`;
/** ~2k chars per message, 100 messages → ~200k: well over the cap. */
const overCapWindow = (first?: string) =>
  Array.from({ length: 100 }, (_, i) => ({
    role: "user",
    content:
      i === 0 && first !== undefined
        ? first
        : `${marker(i)} ${"filler words for the window ".repeat(70)}`,
  }));

const promptOf = (messages: readonly { role: string; content: unknown }[]) => {
  const prepared = prepareSummary(messages);
  if (!("request" in prepared)) {
    throw new Error(`expected a request, got skip: ${prepared.skipped}`);
  }
  return prepared.request.prompt;
};

const occurrences = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

describe("prepareSummary over the cap", () => {
  test("pins the head slice at 20k chars", () => {
    expect(SUMMARIZE_HEAD_CHARS).toBe(20_000);
    expect(SUMMARIZE_ELISION_LINE.length).toBeGreaterThan(0);
  });

  test("keeps the opening and the newest, elides the middle once", () => {
    const prompt = promptOf(overCapWindow());
    expect(prompt).toContain(marker(0));
    expect(prompt).toContain(marker(99));
    // Head keeps ~000–009, newest ~050–099: 030 sits in the elided middle.
    expect(prompt).not.toContain(marker(30));
    expect(occurrences(prompt, SUMMARIZE_ELISION_LINE)).toBe(1);
    expect(prompt.length).toBeLessThanOrEqual(SUMMARY_CAP);
  });

  test("head part, elision line, newest part — in that order", () => {
    const prompt = promptOf(overCapWindow());
    const head = prompt.indexOf(marker(0));
    const elision = prompt.indexOf(SUMMARIZE_ELISION_LINE);
    const newest = prompt.indexOf(marker(99));
    expect(head).toBeGreaterThanOrEqual(0);
    expect(head).toBeLessThan(elision);
    expect(elision).toBeLessThan(newest);
    expect(prompt.startsWith(`user: ${marker(0)}`)).toBe(true);
  });

  test("the head part fills its reserved slice from the opening", () => {
    const prompt = promptOf(overCapWindow());
    const headPart = prompt.slice(0, prompt.indexOf(SUMMARIZE_ELISION_LINE));
    expect(headPart.trimEnd().length).toBeLessThanOrEqual(SUMMARIZE_HEAD_CHARS);
    // ~2k-char messages: a 20k slice holds the first several, not just one.
    expect(headPart).toContain(marker(5));
    // The newest end gets the rest of the budget, not just the head's share.
    const newestPart = prompt.slice(
      prompt.indexOf(SUMMARIZE_ELISION_LINE) + SUMMARIZE_ELISION_LINE.length,
    );
    expect(newestPart.length).toBeGreaterThan(SUMMARY_CAP / 2);
  });

  test("a first message longer than the head slice is trimmed, not dropped", () => {
    const first = `OPENING-SUMMARY ${"host compaction summary text ".repeat(1100)}`;
    expect(first.length).toBeGreaterThan(SUMMARIZE_HEAD_CHARS);
    const prompt = promptOf(overCapWindow(first));
    expect(prompt.startsWith("user: OPENING-SUMMARY")).toBe(true);
    const headPart = prompt.slice(0, prompt.indexOf(SUMMARIZE_ELISION_LINE));
    expect(headPart.trimEnd().length).toBeLessThanOrEqual(SUMMARIZE_HEAD_CHARS);
    expect(occurrences(prompt, SUMMARIZE_ELISION_LINE)).toBe(1);
    expect(prompt).toContain(marker(99));
    expect(prompt).not.toContain(marker(30));
    expect(prompt.length).toBeLessThanOrEqual(SUMMARY_CAP);
  });
});

describe("renderConversation over the cap (extraction path unchanged)", () => {
  test("keeps the newest, drops the oldest, no elision line", () => {
    const text = renderConversation(overCapWindow(), SUMMARY_CAP);
    expect(text).toContain(marker(99));
    expect(text).not.toContain(marker(0));
    expect(text).not.toContain(SUMMARIZE_ELISION_LINE);
    expect(text.length).toBeLessThanOrEqual(SUMMARY_CAP);
  });
});

describe("storeSummary", () => {
  test("stores a type:summary memory with embedding and project, returns its id", async () => {
    const replica = newReplica();
    const id = await storeSummary({
      replica,
      embed: embedFixed,
      projectId: "proj-456",
      text: "A summary produced elsewhere.",
    });
    if (id === null) throw new Error("expected a stored summary id");
    const stored = replica.getMemory(id);
    expect(stored?.type).toBe("summary");
    expect(stored?.content).toBe("A summary produced elsewhere.");
    expect(stored?.project_id).toBe("proj-456");
    expect(replica.listUnembedded(10)).toEqual([]);
    replica.close();
  });

  test("embedder down → stored unembedded, no project when none given", async () => {
    const replica = newReplica();
    const id = await storeSummary({
      replica,
      embed: embedNull,
      text: "Summary without vectors.",
    });
    if (id === null) throw new Error("expected a stored summary id");
    const stored = replica.getMemory(id);
    expect(stored?.type).toBe("summary");
    expect(stored?.content).toBe("Summary without vectors.");
    expect(stored?.project_id ?? null).toBeNull();
    expect(replica.listUnembedded(10)).toHaveLength(1);
    replica.close();
  });

  test("empty text → returns null and stores nothing", async () => {
    const replica = newReplica();
    const id = await storeSummary({ replica, embed: embedFixed, text: "" });
    expect(id).toBeNull();
    expect(replica.listMemories()).toEqual([]);
    expect(replica.countMemories()).toBe(0);
    replica.close();
  });

  test("whitespace-only text → returns null, stores nothing, never embeds", async () => {
    const replica = newReplica();
    const embed = mock(embedFixed);
    const id = await storeSummary({ replica, embed, text: "   \n " });
    expect(id).toBeNull();
    expect(embed).not.toHaveBeenCalled();
    expect(replica.listMemories()).toEqual([]);
    expect(replica.countMemories()).toBe(0);
    replica.close();
  });
});
