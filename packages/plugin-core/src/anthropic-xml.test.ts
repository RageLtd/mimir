import { describe, expect, test } from "bun:test";
import { toAnthropicXml } from "./anthropic-xml";

const PERSONA = `# Working Rules

Read before writing.

# Identity and Voice

My name is Mimir.`;

describe("toAnthropicXml", () => {
  const xml = toAnthropicXml(PERSONA);

  test("places the environment and the override just before the identity section", () => {
    const environment = xml.indexOf("<environment>");
    const override = xml.indexOf("<model_override>");
    const identity = xml.indexOf("<identity_and_voice>");
    expect(environment).toBeGreaterThan(xml.indexOf("<working_rules>"));
    expect(override).toBeGreaterThan(environment);
    expect(identity).toBeGreaterThan(override);
  });

  test("does not describe a delivery it no longer has", () => {
    // The persona was an output style until the hooks module took over the
    // system prompt; telling the model otherwise invites it to look for
    // default-assistant instructions to weigh against the persona.
    expect(xml.toLowerCase()).not.toContain("output style");
  });

  test("says what the application sends beside the conversation", () => {
    // A replaced system prompt is the only place that can say so.
    for (const tag of [
      "<system-reminder>",
      "<boot_context>",
      "<retrieved_context>",
      "<file_context>",
      "<voice_anchor>",
    ]) {
      expect(xml).toContain(tag);
    }
    expect(xml).toContain("Match its register in the next reply");
  });

  test("a host's own environment block replaces the Claude Code one", () => {
    const other = toAnthropicXml(
      PERSONA,
      "<environment>\nElsewhere.\n</environment>",
    );
    expect(other).toContain("Elsewhere.");
    expect(other).not.toContain("<voice_anchor>");
    expect(other).toContain("<model_override>");
  });
});
