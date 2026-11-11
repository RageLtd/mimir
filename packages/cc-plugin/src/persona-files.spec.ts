/**
 * writePersonaFiles — the two persona files an install and a dev-install
 * both land. Pins: the Markdown copy is the prompt byte-for-byte (voice
 * anchors are parsed from it), the XML copy is its Anthropic conversion
 * (the hooks module composes it into every session), and a second write
 * replaces the first.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import { toAnthropicXml } from "@mimir/plugin-core/anthropic-xml";
import { mimirHome } from "@mimir/plugin-core/util";
import { writePersonaFiles } from "./persona-files";

const PROMPT = [
  "# Identity & Voice",
  "",
  "I speak plainly.",
  "",
  "## Voice in Action",
  "",
  "**Reporting finished work and what's next:**",
  "",
  "> Mimir: Done, brother.",
  "",
].join("\n");

test("lands the prompt verbatim and its XML conversion under mimirHome", async () => {
  const written = await writePersonaFiles(PROMPT);

  expect(written).toEqual({
    promptPath: join(mimirHome(), "system-prompt.md"),
    ccPromptPath: join(mimirHome(), "cc", "system-prompt.xml"),
  });
  expect(await Bun.file(written.promptPath).text()).toBe(PROMPT);
  expect(await Bun.file(written.ccPromptPath).text()).toBe(
    toAnthropicXml(PROMPT),
  );
});

test("a second write replaces both files", async () => {
  await writePersonaFiles(PROMPT);
  const next = `${PROMPT}\n**Saying what hasn't been verified:**\n`;
  const written = await writePersonaFiles(next);

  expect(await Bun.file(written.promptPath).text()).toBe(next);
  expect(await Bun.file(written.ccPromptPath).text()).toBe(
    toAnthropicXml(next),
  );
});
