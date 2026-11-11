import { describe, expect, test } from "bun:test";
import { createOrgReplica } from "@mimir/plugin-core/store/org-replica";
import {
  buildLocalContextInjection,
  placeContextInjection,
  retrieveTurnContext,
  scopedRulesBlockForRead,
} from "./turn-context";
import type { ChatMessage } from "./types";

const history: ChatMessage[] = [
  { role: "user", content: "earlier question" },
  { role: "assistant", content: "earlier answer" },
];
const current: ChatMessage = { role: "user", content: "current question" };
const injection = buildLocalContextInjection("<memories/>", null, null);

describe("placeContextInjection", () => {
  test("keeps persisted history as the prefix and injects before the live turn", () => {
    const placed = placeContextInjection(
      [...history, current],
      injection,
      history.length,
    );
    expect(placed.slice(0, history.length)).toEqual(history);
    expect(placed.slice(history.length, history.length + 2)).toEqual(injection);
    expect(placed.at(-1)).toEqual(current);
  });

  test("keeps the live turn's tool exchange after the injection", () => {
    const toolTurn: ChatMessage[] = [
      current,
      { role: "assistant", content: "calling a tool" },
    ];
    const placed = placeContextInjection(
      [...history, ...toolTurn],
      injection,
      history.length,
    );
    expect(placed.slice(history.length + 2)).toEqual(toolTurn);
  });

  test("is the identity when there is nothing to inject", () => {
    const messages = [...history, current];
    expect(placeContextInjection(messages, [], history.length)).toEqual(
      messages,
    );
  });

  test("on the first turn the injection leads", () => {
    const placed = placeContextInjection([current], injection, 0);
    expect(placed).toEqual([...injection, current]);
  });
});

describe("scopedRulesBlockForRead", () => {
  const entries = [
    { path: "AGENTS.md", content: "Always." },
    { path: ".claude/rules/c.md", content: "Braces.", paths: ["src/**/*.c"] },
  ];
  const makeSession = () => ({
    projectPath: "/repo",
    projectRuleEntries: entries,
    scopedRulesSeen: new Set<string>(),
  });

  test("renders matching scoped rules for a read, once per session", () => {
    const session = makeSession();
    const first = scopedRulesBlockForRead(session, "fs_read_text_file", {
      path: "/repo/src/main.c",
    });
    expect(first).toContain('<project_rules scope="src/main.c">');
    expect(first).toContain("Braces.");
    expect(first).not.toContain("Always.");
    expect(
      scopedRulesBlockForRead(session, "fs_read_text_file", {
        path: "/repo/src/other.c",
      }),
    ).toBeNull();
  });

  test("ignores other tools, missing paths, and non-matching files", () => {
    const session = makeSession();
    expect(
      scopedRulesBlockForRead(session, "fs_write_text_file", {
        path: "/repo/src/main.c",
      }),
    ).toBeNull();
    expect(
      scopedRulesBlockForRead(session, "fs_read_text_file", {}),
    ).toBeNull();
    expect(
      scopedRulesBlockForRead(session, "fs_read_text_file", {
        path: "/repo/README.md",
      }),
    ).toBeNull();
    expect(session.scopedRulesSeen.size).toBe(0);
  });
});

describe("retrieveTurnContext", () => {
  const PROMPT = "why does the gateway time out";
  const embedQuery = async (text: string) =>
    text === PROMPT ? [1, 0, 0] : null;
  // Cosine distance 0.6 from the prompt: past every distance cutoff.
  const far = [0.4, Math.sqrt(1 - 0.4 * 0.4), 0];

  const seededReplica = () => {
    const replica = createOrgReplica(":memory:");
    replica.upsertMemory({
      id: "summary:ours-old",
      content: "our older summary",
      embedding: far,
      created_at: "2026-10-01 09:00:00",
      project_id: "project:a",
      type: "summary",
    });
    replica.upsertMemory({
      id: "summary:ours-new",
      content: "where our last session left off",
      embedding: far,
      created_at: "2026-10-18 09:00:00",
      project_id: "project:a",
      type: "summary",
    });
    replica.upsertMemory({
      id: "summary:theirs",
      content: "another project's newer summary",
      embedding: far,
      created_at: "2026-10-20 09:00:00",
      project_id: "project:b",
      type: "summary",
    });
    return replica;
  };

  test("a session's first prompt gets the active project's newest summary, near or not", async () => {
    const replica = seededReplica();
    const session = { projectId: "project:a", bootSequenceDone: false };

    const result = await retrieveTurnContext(
      replica,
      session,
      PROMPT,
      embedQuery,
    );

    expect(result.contextBlock).toContain("where our last session left off");
    expect(result.contextBlock).not.toContain("another project's");
    expect(result.contextBlock).not.toContain("our older summary");
    expect(session.bootSequenceDone).toBe(true);
  });

  test("a later prompt gets only what is near it", async () => {
    const replica = seededReplica();
    const session = { projectId: "project:a", bootSequenceDone: false };

    await retrieveTurnContext(replica, session, PROMPT, embedQuery);
    const later = await retrieveTurnContext(
      replica,
      session,
      PROMPT,
      embedQuery,
    );

    expect(later.contextBlock).not.toContain("where our last session");
    expect(later.summaryCount).toBe(0);
  });
});
