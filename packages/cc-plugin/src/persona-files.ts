/**
 * The persona as it sits on disk: the canonical prompt, byte for byte, at
 * ~/.mimir/system-prompt.md (voice anchors are parsed from it) and its
 * Anthropic-XML conversion at ~/.mimir/cc/system-prompt.xml (what the
 * hooks module composes into every session's system prompt).
 *
 * One writer for both sources of a prompt — the server's, on install and
 * update, and the repo's seed, on dev-install — so a persona tried
 * locally is rendered exactly as a released one will be.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { toAnthropicXml } from "@mimir/plugin-core/anthropic-xml";
import { mimirHome } from "@mimir/plugin-core/util";

const writeText = async (path: string, contents: string) => {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, contents);
};

export const writePersonaFiles = async (prompt: string) => {
  const home = mimirHome();
  const promptPath = join(home, "system-prompt.md");
  const ccPromptPath = join(home, "cc", "system-prompt.xml");
  // Shared persona stays byte-for-byte canonical; CC enrichment is host-local.
  await writeText(promptPath, prompt);
  await writeText(ccPromptPath, toAnthropicXml(prompt));
  return { promptPath, ccPromptPath };
};
