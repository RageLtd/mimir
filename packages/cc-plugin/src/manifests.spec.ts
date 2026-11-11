/**
 * The plugin-shipped manifests are what a desktop-app session loads
 * instead of the wrapper's flags: hooks/hooks.json and .mcp.json. Pin
 * the subcommands the hooks module runs to the binary's dispatch table
 * so a renamed subcommand can't strand a hook.
 */

import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { LOCAL_TOOL_PREFIX } from "@mimir/plugin-core/anthropic-xml";

const ROOT = join(import.meta.dir, "..");
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal MCP placeholder — Claude Code expands it, not JS
const MCP_BIN = "${HOME}/.local/bin/mimir-cc";

const hooksJson = (await Bun.file(
  join(ROOT, "hooks", "hooks.json"),
).json()) as {
  readonly modules?: readonly string[];
  readonly hooks?: unknown;
};
const mcpJson = (await Bun.file(join(ROOT, ".mcp.json")).json()) as {
  readonly mcpServers: Record<string, { command: string; args: string[] }>;
};
const settingsTemplate = (await Bun.file(
  join(ROOT, "artifacts", "settings.json.template"),
).json()) as Record<string, unknown>;
const cliSource = await Bun.file(join(ROOT, "src", "cli.ts")).text();

/** Every subcommand a module file spells in `mimirCcArgv(home, "<sub>")`. */
const moduleSubcommands = async () => {
  const dir = join(ROOT, "hooks");
  const files = (await readdir(dir)).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
  const found = new Set<string>();
  for (const file of files) {
    const source = await Bun.file(join(dir, file)).text();
    for (const m of source.matchAll(/mimirCcArgv\([^,]+,\s*"([a-z-]+)"\)/g)) {
      if (m[1]) found.add(m[1]);
    }
  }
  return [...found].sort();
};

describe("hooks/hooks.json", () => {
  test("names the hooks module and no command hooks", () => {
    expect(hooksJson.modules).toEqual(["./register.ts"]);
    expect(hooksJson).not.toHaveProperty("hooks");
  });

  test("every subcommand the module runs exists in the CLI dispatch table", async () => {
    const subcommands = await moduleSubcommands();
    expect(subcommands).toEqual([
      "boot-context",
      "file-context",
      "guard",
      "persist",
      "precompact",
      "reindex",
      "retrieve",
      "rules",
      "session-end",
      "session-start",
      "verify",
      "voice-anchor",
    ]);
    for (const sub of subcommands) {
      expect(cliSource).toContain(`case "${sub}":`);
    }
  });
});

describe("settings.json.template", () => {
  test("carries neither hooks nor an output style — both come from the plugin", () => {
    expect(settingsTemplate).not.toHaveProperty("hooks");
    expect(settingsTemplate).not.toHaveProperty("outputStyle");
  });

  test("turns auto-update on for the marketplace the plugin ships from", () => {
    // Off by default for a third-party marketplace, and nothing in
    // marketplace.json can turn it on: without it an install stays on the
    // release it was installed at.
    expect(settingsTemplate.extraKnownMarketplaces).toEqual({
      rageltd: {
        source: { source: "github", repo: "RageLtd/claude-plugins" },
        autoUpdate: true,
      },
    });
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
