import { expect, test } from "bun:test";
import { buildRuntimePrompt } from "./environment";

test("ACP adds only its environment after the byte-exact canonical persona", async () => {
  const persona = await Bun.file(
    new URL("../../../server/system-prompt.md", import.meta.url),
  ).text();
  const tools = ["user_memory_search", "fs_read_text_file", "create_terminal"];
  const rendered = buildRuntimePrompt(persona, tools);
  expect(rendered.slice(0, persona.length)).toBe(persona);
  const environment = rendered.slice(persona.length);
  expect(environment).toStartWith("\n\n<environment>");
  expect(environment).toEndWith("</environment>");
  expect(environment).toContain("mimir-acp");
  expect(environment).toContain("Agent Client Protocol");
  for (const tool of tools) expect(environment).toContain(tool);
  expect(environment).not.toContain("project_memory_search");
  expect(environment).not.toContain("mcp__plugin_mimir-cc");
});

test("ACP lists the actual session tools rather than assuming optional servers", () => {
  const tool = "editor.docs_lookup";
  const rendered = buildRuntimePrompt("Persona.\n", [tool]);
  expect(rendered).toContain(tool);
  expect(rendered).not.toContain("cartographer_search");
});
