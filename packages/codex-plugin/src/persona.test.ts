import { describe, expect, test } from "bun:test";
import { toAnthropicXml } from "@mimir/plugin-core/anthropic-xml";
import { cartToolNames } from "@mimir/plugin-core/tools/cart-tools";
import { orgMemoryToolNames } from "@mimir/plugin-core/tools/org-memory";
import { userMemoryToolDefs } from "@mimir/plugin-core/tools/user-memory";
import { parseVoiceAnchors } from "@mimir/plugin-core/voice-anchor";
import configTemplate from "../artifacts/config.toml.template" with {
  type: "text",
};
import { renderCodexPersona } from "./persona";

const PERSONA = `Aye, brother.
# Working Rules
Keep confidences.
# Identity and Voice
My name is Mimir. Speak plainly.
## Voice in Action
**Giving counsel:**
> Developer: Should we duplicate it?
>
> Mimir: No, brother. Keep it simple.
## Voice Principles
Vary the rhythm.`;

const ENVIRONMENT = /<environment>[\s\S]*?<\/environment>/;
const stripEnvironment = (prompt: string) => prompt.replace(ENVIRONMENT, "");

describe("renderCodexPersona", () => {
  test("adds exactly one Codex environment without another host's identity", () => {
    const rendered = renderCodexPersona(PERSONA);
    const environment = rendered.match(ENVIRONMENT)?.[0] ?? "";
    expect(rendered.match(/<environment>/g)).toHaveLength(1);
    expect(rendered.match(/<\/environment>/g)).toHaveLength(1);
    expect(rendered).toContain("You are running in Codex");
    expect(rendered).toContain("AGENTS.md");
    expect(rendered).toContain("CODEX_HOME");
    expect(rendered).toContain("mimir-codex wrapper launches Codex CLI");
    expect(rendered).toContain("mimir-codex-acp wrapper");
    expect(rendered).toContain("does not run Mimir's standalone ACP agent");
    expect(rendered.indexOf("</environment>")).toBeLessThan(
      rendered.indexOf("<identity_and_voice>"),
    );
    for (const forbidden of [
      "Claude",
      "Anthropic",
      "mimir-cc",
      "mcp__",
      "<model_override>",
      "context7",
      "WebSearch",
      "WebFetch",
      "Zed",
    ]) {
      expect(environment).not.toContain(forbidden);
    }
  });

  test("describes configured servers and verified canonical tool names", () => {
    const rendered = renderCodexPersona(PERSONA);
    for (const server of ["mimir-local", "mimir-logs"]) {
      expect(configTemplate).toContain(`[mcp_servers.${server}]`);
      expect(rendered).toContain(`${server} (stdio)`);
    }
    expect(configTemplate).toContain("{{CARTOGRAPHER_BLOCK}}");
    expect(rendered).toContain("cartographer (stdio, when configured)");
    const names = new Set([
      ...userMemoryToolDefs.map((tool) => tool.function.name),
      ...orgMemoryToolNames,
      ...cartToolNames,
    ]);
    for (const name of [
      "user_memory_search",
      "user_profile_get",
      "project_memory_search",
      "project_playbook_store",
      "cartographer_search",
      "cartographer_file_info",
      "cartographer_query",
    ]) {
      expect(names.has(name)).toBe(true);
      expect(rendered).toContain(name);
    }
    expect(rendered).toContain("read_codex_plugin_logs");
    expect(rendered).toContain(
      "Discover the actual callable names and schemas",
    );
  });

  test("preserves the canonical persona and XML voice-anchor parsing", () => {
    const rendered = renderCodexPersona(PERSONA);
    expect(stripEnvironment(rendered)).toBe(
      stripEnvironment(toAnthropicXml(PERSONA)),
    );
    expect(rendered).toContain("<model_override>");
    expect(rendered).toContain("<voice_in_action>");
    expect(parseVoiceAnchors(rendered)).toEqual([
      {
        title: "Giving counsel",
        body: "Developer: Should we duplicate it?\n\nMimir: No, brother. Keep it simple.",
      },
    ]);
  });

  test("preserves every non-environment byte and voice example from the actual seed", async () => {
    const seed = await Bun.file(
      new URL("../../server/system-prompt.md", import.meta.url),
    ).text();
    const rendered = renderCodexPersona(seed);
    const original = toAnthropicXml(seed);
    expect(rendered.match(/<environment>/g)).toHaveLength(1);
    expect(stripEnvironment(rendered)).toBe(stripEnvironment(original));
    const anchors = parseVoiceAnchors(original);
    expect(anchors.length).toBeGreaterThan(0);
    expect(parseVoiceAnchors(rendered)).toEqual(anchors);
  });

  test("appends the runtime context when no identity section is present", () => {
    const rendered = renderCodexPersona("# Working Rules\nKeep confidences.");
    expect(rendered.match(/<environment>/g)).toHaveLength(1);
    expect(rendered).toStartWith(
      "<working_rules>\nKeep confidences.\n</working_rules>",
    );
    expect(stripEnvironment(rendered)).toBe(
      stripEnvironment(toAnthropicXml("# Working Rules\nKeep confidences.")),
    );
    expect(rendered).toEndWith("</model_override>");
  });
});
