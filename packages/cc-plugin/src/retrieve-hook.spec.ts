/**
 * Tests for retrieveFailureOutput: what the hook prints when retrieval
 * itself fails (the replica cannot be opened, or retrieval throws). On a
 * first prompt the summary must stay owed — printing nothing would read as
 * settled — but nothing may claim the summary is "still generating",
 * because no one looked.
 *
 * The retrieval sequence, its options and the output for a successful
 * retrieval live in plugin-core and are tested there
 * (`brain/retrieve-prompt.test.ts`).
 */

import { describe, expect, test } from "bun:test";
import { retrieveFailureOutput } from "./retrieve-hook";

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
