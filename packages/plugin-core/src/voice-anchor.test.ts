import { describe, expect, test } from "bun:test";
import { parseVoiceAnchors } from "./voice-anchor";

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
});
