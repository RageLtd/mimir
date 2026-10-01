/**
 * The plugin-shipped manifests are what a desktop-app session loads
 * instead of the wrapper's flags: hooks/hooks.json, .mcp.json, and the
 * output style the installer renders. Pin their shape to the binary's
 * dispatch table so a renamed subcommand can't strand a hook.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LOCAL_TOOL_PREFIX } from "@mimir/plugin-core/anthropic-xml";
import { renderOutputStyle } from "./install";
import { OUTPUT_STYLE_NAME } from "./project-settings";

const ROOT = join(import.meta.dir, "..");
const BIN = 'MIMIR_ACTIVE=1 "$HOME/.local/bin/mimir-cc" ';
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal MCP placeholder — Claude Code expands it, not JS
const MCP_BIN = "${HOME}/.local/bin/mimir-cc";

type HookEntry = {
  readonly matcher?: string;
  readonly hooks: readonly { readonly command: string }[];
};

const hooksJson = (await Bun.file(
  join(ROOT, "hooks", "hooks.json"),
).json()) as {
  readonly hooks: Record<string, readonly HookEntry[]>;
};
const mcpJson = (await Bun.file(join(ROOT, ".mcp.json")).json()) as {
  readonly mcpServers: Record<string, { command: string; args: string[] }>;
};
const settingsTemplate = (await Bun.file(
  join(ROOT, "artifacts", "settings.json.template"),
).json()) as Record<string, unknown>;
const cliSource = await Bun.file(join(ROOT, "src", "cli.ts")).text();

const allCommands = Object.values(hooksJson.hooks)
  .flat()
  .flatMap((entry) => entry.hooks.map((h) => h.command));

describe("hooks/hooks.json", () => {
  test("every hook runs the installed binary with MIMIR_ACTIVE set inline", () => {
    expect(allCommands.length).toBeGreaterThan(0);
    for (const command of allCommands) expect(command).toStartWith(BIN);
  });

  test("every hook subcommand exists in the CLI dispatch table", () => {
    for (const command of allCommands) {
      const sub = command.slice(BIN.length);
      expect(cliSource).toContain(`case "${sub}":`);
    }
  });

  test("covers the lifecycle the wrapper used to wire", () => {
    expect(Object.keys(hooksJson.hooks).sort()).toEqual([
      "PostToolUse",
      "PreCompact",
      "PreToolUse",
      "SessionStart",
      "Stop",
      "SubagentStop",
      "UserPromptSubmit",
    ]);
  });
});

describe("settings.json.template", () => {
  test("carries no hooks and pins the output style off under the wrapper", () => {
    // The wrapper replaces the system prompt wholesale; an output style
    // is still appended on top of a replaced prompt, so the wrapper's
    // settings must switch it off or the persona arrives twice.
    expect(settingsTemplate).not.toHaveProperty("hooks");
    expect(settingsTemplate.outputStyle).toBe("default");
  });
});

describe(".mcp.json", () => {
  test("ships the local brain and the log server from the installed binary", () => {
    expect(mcpJson.mcpServers["mimir-local"]).toEqual({
      command: MCP_BIN,
      args: ["user-memory-mcp"],
    });
    expect(mcpJson.mcpServers["mimir-logs"]).toEqual({
      command: MCP_BIN,
      args: ["log-mcp"],
    });
  });

  test("the prompt's tool prefix matches the plugin and server names", () => {
    expect(LOCAL_TOOL_PREFIX).toBe("mcp__plugin_mimir-cc_mimir-local__");
  });
});

describe("renderOutputStyle", () => {
  test("names the style, drops Claude Code's coding instructions, and carries the prompt", () => {
    const md = renderOutputStyle(
      "<identity_and_voice>Mimir.</identity_and_voice>",
    );
    const [, frontmatter, body] = md.split("---\n");
    expect(frontmatter).toContain(`name: ${OUTPUT_STYLE_NAME}\n`);
    expect(frontmatter).toContain("description:");
    expect(frontmatter).not.toContain("keep-coding-instructions: true");
    expect(frontmatter).not.toContain("force-for-plugin");
    expect(body).toContain("<identity_and_voice>Mimir.</identity_and_voice>");
  });
});
