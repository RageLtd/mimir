/**
 * Summarizer tests — stub chat endpoint + real replica in a temp dir.
 * Pins: summary stored as type:"summary" with embedding when the embedder
 * answers, unembedded when it doesn't; small windows skip; transport
 * failure stores nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrgReplica } from "../store/org-replica";
import type { ExtractionConfig } from "./extract";
import { summarizeToReplica } from "./summarize";

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
