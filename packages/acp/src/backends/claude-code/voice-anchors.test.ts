import { describe, expect, test } from "bun:test";
import {
  createAnchorState,
  formatAnchor,
  hashSessionStart,
  nextAnchor,
  parseVoiceAnchors,
  type VoiceAnchor,
} from "./voice-anchors";

// ── parseVoiceAnchors ──

const SAMPLE_PROMPT = `
# Identity

Some preamble that must be ignored.

## Voice in Action

Intro paragraph, also ignored.

**Noticing something in passing:**

> Mimir: Now that's a tidy bit of work, brother.

**Pushing back on a bad decision:**

> Developer: Let's just duplicate the handler.
>
> Mimir: Aye, I hear you — but bollocks to "refactor later."

**Yielding when overruled:**

> Developer: We're shipping today.
>
> Mimir: Very well.

## Voice Principles

This section must NOT be parsed into anchors.

**Not a title, this is in a different section:**

> Not an anchor either.
`;

describe("parseVoiceAnchors", () => {
  test("extracts all exchanges between the Voice in Action heading and the next ## heading", () => {
    const anchors = parseVoiceAnchors(SAMPLE_PROMPT);
    expect(anchors).toHaveLength(3);
  });

  test("handles Mimir-only exchanges with no developer line", () => {
    const anchors = parseVoiceAnchors(SAMPLE_PROMPT);
    expect(anchors[0]?.title).toBe("Noticing something in passing");
    expect(anchors[0]?.body).toBe(
      "Mimir: Now that's a tidy bit of work, brother.",
    );
  });

  test("preserves the blank line between Developer and Mimir in two-speaker exchanges", () => {
    const anchors = parseVoiceAnchors(SAMPLE_PROMPT);
    expect(anchors[1]?.title).toBe("Pushing back on a bad decision");
    expect(anchors[1]?.body).toBe(
      [
        "Developer: Let's just duplicate the handler.",
        "",
        `Mimir: Aye, I hear you — but bollocks to "refactor later."`,
      ].join("\n"),
    );
  });

  test("stops at the next ## heading and ignores anything after", () => {
    const anchors = parseVoiceAnchors(SAMPLE_PROMPT);
    const titles = anchors.map((a) => a.title);
    expect(titles).not.toContain("Not a title, this is in a different section");
  });

  test("returns an empty array when the section exists but contains no anchors", () => {
    const empty = `## Voice in Action\n\nIntro but no exchanges.\n\n## Next Section\n`;
    expect(parseVoiceAnchors(empty)).toEqual([]);
  });

  test("throws when the Voice in Action heading is missing", () => {
    expect(() => parseVoiceAnchors("# No section here\n\nbody\n")).toThrow(
      /Voice in Action/,
    );
  });

  test("parses exchanges at the very end of the file (no trailing heading)", () => {
    const noTrailingHeading = `## Voice in Action\n\n**Only one:**\n\n> Mimir: Aye.\n`;
    const anchors = parseVoiceAnchors(noTrailingHeading);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.title).toBe("Only one");
  });
});

// ── formatAnchor ──

describe("formatAnchor", () => {
  test("wraps body in <voice_anchor> tags", () => {
    const anchor: VoiceAnchor = {
      title: "x",
      body: "Mimir: Aye.",
    };
    expect(formatAnchor(anchor)).toBe(
      "<voice_anchor>\nMimir: Aye.\n</voice_anchor>",
    );
  });
});

// ── hashSessionStart ──

describe("hashSessionStart", () => {
  test("returns 0 when library size is zero", () => {
    expect(hashSessionStart("session_abc", 0)).toBe(0);
  });

  test("is deterministic for the same input", () => {
    const a = hashSessionStart("session_xyz_123", 10);
    const b = hashSessionStart("session_xyz_123", 10);
    expect(a).toBe(b);
  });

  test("produces values within [0, libSize)", () => {
    const ids = ["a", "session_1", "session_2", "longer_session_id_foo"];
    for (const id of ids) {
      const h = hashSessionStart(id, 7);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(7);
    }
  });
});

// ── nextAnchor rotation and gating ──

const library: VoiceAnchor[] = Array.from({ length: 3 }, (_, i) => ({
  title: `t${i}`,
  body: `body ${i}`,
}));

describe("nextAnchor", () => {
  test("does not inject on turn 1 when interval is 6", () => {
    const state = { turnCount: 0, lastAnchorTurn: 0, anchorIndex: 0 };
    const step = nextAnchor(state, library, 6);
    expect(step.inject).toBe(false);
    expect(step.next.turnCount).toBe(1);
  });

  test("injects on the Nth turn when interval is N", () => {
    let state = { turnCount: 0, lastAnchorTurn: 0, anchorIndex: 0 };
    for (let turn = 1; turn < 6; turn++) {
      const step = nextAnchor(state, library, 6);
      expect(step.inject).toBe(false);
      state = step.next;
    }
    const last = nextAnchor(state, library, 6);
    expect(last.inject).toBe(true);
    if (last.inject) {
      expect(last.anchor.title).toBe("t0");
      expect(last.next.lastAnchorTurn).toBe(6);
    }
  });

  test("does not inject on the turn immediately after an injection", () => {
    const state = { turnCount: 6, lastAnchorTurn: 6, anchorIndex: 1 };
    const step = nextAnchor(state, library, 6);
    expect(step.inject).toBe(false);
    expect(step.next.turnCount).toBe(7);
  });

  test("rotates through the library and wraps around", () => {
    const interval = 2;
    let state = { turnCount: 0, lastAnchorTurn: 0, anchorIndex: 0 };
    const sequence: string[] = [];

    // Take 6 injection cycles. Each injection takes `interval` turns to arrive.
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < interval - 1; j++) {
        const skip = nextAnchor(state, library, interval);
        expect(skip.inject).toBe(false);
        state = skip.next;
      }
      const hit = nextAnchor(state, library, interval);
      expect(hit.inject).toBe(true);
      if (hit.inject) {
        sequence.push(hit.anchor.title);
        state = hit.next;
      }
    }

    // With library size 3, 6 injections should hit each anchor exactly twice
    // in order: t0, t1, t2, t0, t1, t2.
    expect(sequence).toEqual(["t0", "t1", "t2", "t0", "t1", "t2"]);
  });

  test("is a no-op when the library is empty", () => {
    const state = { turnCount: 0, lastAnchorTurn: 0, anchorIndex: 0 };
    const step = nextAnchor(state, [], 1);
    expect(step.inject).toBe(false);
    expect(step.next.turnCount).toBe(1);
  });
});

// ── createAnchorState ──

describe("createAnchorState", () => {
  test("initialises counters to zero", () => {
    const state = createAnchorState("session_abc", 5);
    expect(state.turnCount).toBe(0);
    expect(state.lastAnchorTurn).toBe(0);
  });

  test("starts different sessions at different rotation offsets", () => {
    const libSize = 10;
    const a = createAnchorState("session_alpha_123456", libSize);
    const b = createAnchorState("session_beta_789012", libSize);
    // Not strictly guaranteed to differ for every pair, but these two
    // specific inputs are chosen to produce distinct hashes.
    expect(a.anchorIndex).not.toBe(b.anchorIndex);
  });

  test("produces an anchorIndex of zero when library is empty", () => {
    const state = createAnchorState("session_abc", 0);
    expect(state.anchorIndex).toBe(0);
  });
});
