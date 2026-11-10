import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  anchorIntervalFrom,
  DEFAULT_ANCHOR_INTERVAL,
  parseVoiceAnchors,
} from "./voice-anchor";

const expected = [
  {
    title: "Pushing back",
    body: "Developer: Ship the duplication.\n\nMimir: It'll bite us, brother.",
  },
];

describe("parseVoiceAnchors", () => {
  test("parses a converted XML prompt", () => {
    const prompt = `<identity_and_voice>
<voice_in_action>
**Pushing back:**

> Developer: Ship the duplication.
>
> Mimir: It'll bite us, brother.
</voice_in_action>
</identity_and_voice>`;

    expect(parseVoiceAnchors(prompt)).toEqual(expected);
  });

  test("parses the canonical Markdown prompt", () => {
    const prompt = `# Identity and Voice

## Voice in Action

**Pushing back:**

> Developer: Ship the duplication.
>
> Mimir: It'll bite us, brother.

## Voice Principles

Repetition is a malfunction.`;

    expect(parseVoiceAnchors(prompt)).toEqual(expected);
  });

  test("rejects a prompt without a voice library", () => {
    expect(() => parseVoiceAnchors("# Identity\n\nMimir.")).toThrow(
      "'Voice in Action' section not found",
    );
  });

  test("the shipped persona carries the reporting exchanges", async () => {
    const persona = await Bun.file(
      join(import.meta.dir, "..", "..", "server", "system-prompt.md"),
    ).text();
    const titles = parseVoiceAnchors(persona).map((anchor) => anchor.title);

    // The register a long working session is mostly in, and the one the
    // library had no exchange for.
    expect(titles).toEqual(
      expect.arrayContaining([
        "Reporting finished work and what's next",
        "Saying what hasn't been verified",
        "Not knowing the answer",
        "A modest verdict on a small win",
      ]),
    );
    expect(titles).toHaveLength(14);
  });
});

describe("anchorIntervalFrom", () => {
  test("a positive integer is the interval; anything else is the default", () => {
    expect(anchorIntervalFrom("5")).toBe(5);
    expect(anchorIntervalFrom(undefined)).toBe(DEFAULT_ANCHOR_INTERVAL);
    expect(anchorIntervalFrom("0")).toBe(DEFAULT_ANCHOR_INTERVAL);
    expect(anchorIntervalFrom("nope")).toBe(DEFAULT_ANCHOR_INTERVAL);
    expect(DEFAULT_ANCHOR_INTERVAL).toBe(3);
  });
});
