/**
 * Tests for retrieveOptions: the pure map from the UserPromptSubmit payload
 * (plus what the hook resolved around it) to retrieval's options. The
 * hooks module flags a session's first prompt `session_start`; retrieval
 * must see it as `sessionStart`, or a new session never learns where the
 * last one left off.
 *
 * And retrieveOutput: the pure map from retrieval's result to what the
 * hook prints — including the `summaryPending` flag that tells the hooks
 * module the last session's summary is still owed.
 */

import { describe, expect, test } from "bun:test";
import {
  retrieveFailureOutput,
  retrieveOptions,
  retrieveOutput,
} from "./retrieve-hook";

const resolved = {
  projectId: "project:a",
  exclude: new Set<string>(["memory:seen"]),
  projectNames: { "project:b": "data-services" },
  summaryPending: false,
};

describe("retrieveOptions", () => {
  test("a session's first prompt asks retrieval for the session-start summary", () => {
    const opts = retrieveOptions(
      { prompt: "hi", session_start: true },
      resolved,
    );
    expect(opts.sessionStart).toBe(true);
    expect(opts.projectId).toBe("project:a");
    expect(opts.exclude).toEqual(new Set(["memory:seen"]));
    expect(opts.projectNames).toEqual({ "project:b": "data-services" });
  });

  test("a later prompt does not", () => {
    expect(
      retrieveOptions({ prompt: "hi", session_start: false }, resolved)
        .sessionStart,
    ).toBe(false);
    expect(retrieveOptions({ prompt: "hi" }, resolved).sessionStart).toBe(
      false,
    );
  });

  test("an unresolved project is no project, not a null id", () => {
    const opts = retrieveOptions(
      { prompt: "hi", session_start: true },
      { ...resolved, projectId: null },
    );
    expect(opts.projectId).toBeUndefined();
  });

  test("a summary still being written is passed to retrieval on the first prompt", () => {
    const pending = { ...resolved, summaryPending: true };
    expect(
      retrieveOptions({ prompt: "hi", session_start: true }, pending)
        .summaryPending,
    ).toBe(true);
    expect(
      retrieveOptions({ prompt: "hi", session_start: true }, resolved)
        .summaryPending,
    ).toBe(false);
  });

  test("a pending summary means nothing to a later prompt", () => {
    const pending = { ...resolved, summaryPending: true };
    expect(
      retrieveOptions({ prompt: "hi", session_start: false }, pending)
        .summaryPending,
    ).toBe(false);
    expect(retrieveOptions({ prompt: "hi" }, pending).summaryPending).toBe(
      false,
    );
  });
});

const BLOCK = "<retrieved_context>one memory</retrieved_context>";
const PROJECT = { projectId: "project:a" };

const result = (over: {
  contextBlock?: string;
  memoryCount?: number;
  summaryCount?: number;
  embedderUnavailable?: boolean;
  summaryDeferred?: boolean;
}) => ({
  contextBlock: over.contextBlock ?? "",
  memoryCount: over.memoryCount ?? 0,
  summaryCount: over.summaryCount ?? 0,
  injectedIds: [],
  embedderUnavailable: over.embedderUnavailable ?? false,
  summaryDeferred: over.summaryDeferred ?? false,
});

describe("retrieveOutput", () => {
  test("injects the block under the active project with the retrieval count", () => {
    const out = retrieveOutput(
      result({ contextBlock: BLOCK, memoryCount: 2, summaryCount: 1 }),
      PROJECT,
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `<active_project id="project:a" />\n${BLOCK}`,
      },
      systemMessage: "↻ Retrieved 2 memories / 1 summaries (local)",
    });
    expect(out !== null && "summaryPending" in out).toBe(false);
  });

  test("an unresolved project injects the block without a prefix", () => {
    const out = retrieveOutput(
      result({ contextBlock: BLOCK, memoryCount: 1 }),
      { projectId: null },
    );
    expect(out?.hookSpecificOutput?.additionalContext).toBe(BLOCK);
  });

  test("a deferred summary is flagged, and the developer told it is still generating", () => {
    const out = retrieveOutput(
      result({ contextBlock: BLOCK, memoryCount: 1, summaryDeferred: true }),
      PROJECT,
    );
    expect(out?.summaryPending).toBe(true);
    expect(out?.systemMessage).toContain("still generating");
    expect(out?.hookSpecificOutput?.additionalContext).toContain(BLOCK);
  });

  test("a deferred summary is flagged even when there is nothing to inject", () => {
    const out = retrieveOutput(result({ summaryDeferred: true }), PROJECT);
    expect(out).not.toBeNull();
    expect(out?.summaryPending).toBe(true);
    expect(out?.systemMessage).toContain("still generating");
    expect(out !== null && "hookSpecificOutput" in out).toBe(false);
  });

  test("nothing to inject and nothing deferred prints nothing", () => {
    expect(retrieveOutput(result({}), PROJECT)).toBeNull();
  });

  test("an empty block from a missing embedder still says so", () => {
    expect(
      retrieveOutput(result({ embedderUnavailable: true }), PROJECT),
    ).toEqual({
      systemMessage: "↻ Retrieval skipped: the embedder gave no vector",
    });
  });
});

/**
 * retrieveFailureOutput: what the hook prints when retrieval itself fails
 * (the replica cannot be opened, or retrieval throws). On a first prompt
 * the summary must stay owed — printing nothing would read as settled —
 * but nothing may claim the summary is "still generating", because no one
 * looked.
 */
describe("retrieveFailureOutput", () => {
  test("a first prompt keeps the summary owed, without claiming it is generating", () => {
    const out = retrieveFailureOutput({ prompt: "hi", session_start: true });
    expect(out).toEqual({ summaryPending: true });
    expect(JSON.stringify(out)).not.toContain("still generating");
    expect(out !== null && "systemMessage" in out).toBe(false);
    expect(out !== null && "hookSpecificOutput" in out).toBe(false);
  });

  test("a later prompt prints nothing", () => {
    expect(
      retrieveFailureOutput({ prompt: "hi", session_start: false }),
    ).toBeNull();
    expect(retrieveFailureOutput({ prompt: "hi" })).toBeNull();
  });
});
