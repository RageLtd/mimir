/**
 * The Mimir persona as a plugin output style — `output-styles/mimir.md`,
 * rendered from the server's system-prompt seed by
 * `scripts/render-output-style.ts`, committed, and checked for drift by
 * `output-style.spec.ts`.
 *
 * `force-for-plugin: true` has the engine apply it whenever the plugin is
 * enabled, which still holds where an organization passes `prompt.compose`
 * over plugins a person installs and the hooks module's persona never runs.
 * No `keep-coding-instructions`: the persona replaces the engine's coding
 * instructions, as the hooks module does.
 */

import { resolve } from "node:path";
import {
  claudeCodeEnvironment,
  toAnthropicXml,
} from "@mimir/plugin-core/anthropic-xml";
import { PROMPT_SEED } from "./agents";

/** The style is read only where the hooks module's persona is not, so it
 *  cannot claim the hook's delivery or the installer's copy. */
const OUTPUT_STYLE_DELIVERY =
  "You are running as a Claude Code session with the mimir-cc plugin enabled: Claude Code's engine and tools, with the Mimir persona and MCP servers supplied by the plugin. This text reaches you as the plugin's output style, beside Claude Code's own system prompt, because the organization managing this Claude Code passes over the plugin's prompt hooks. Where a line elsewhere in your instructions names you as Claude Code, it names the application you are running in, not who you are. The persona text is the copy shipped with this plugin release.";

const OUTPUT_STYLE_ENVIRONMENT = claudeCodeEnvironment(OUTPUT_STYLE_DELIVERY);

/** Where Claude Code discovers a plugin's output styles. */
export const OUTPUT_STYLE_FILE = resolve(
  import.meta.dir,
  "..",
  "output-styles",
  "mimir.md",
);

export const OUTPUT_STYLE_DESCRIPTION =
  "Mimir persona, forced while the mimir-cc plugin is enabled";

/** The description is JSON-quoted so its punctuation survives YAML. */
export const renderOutputStyle = (
  seed: string,
  description = OUTPUT_STYLE_DESCRIPTION,
) => {
  const frontmatter = [
    "name: Mimir",
    `description: ${JSON.stringify(description)}`,
    "force-for-plugin: true",
  ];
  return `---\n${frontmatter.join("\n")}\n---\n\n${toAnthropicXml(seed, OUTPUT_STYLE_ENVIRONMENT)}\n`;
};

export const renderSeedOutputStyle = async () =>
  renderOutputStyle(await Bun.file(PROMPT_SEED).text());
