import { test, expect, describe } from "bun:test";
import { markdownToXml, toAnthropicXml } from "./markdown-to-xml";

describe("markdownToXml", () => {
  test("converts h1 headings to XML tags", () => {
    const md = "# Critical Rules\nDo the thing.";
    const xml = markdownToXml(md);
    expect(xml).toContain("<critical_rules>");
    expect(xml).toContain("Do the thing.");
    expect(xml).toContain("</critical_rules>");
  });

  test("nests h2 inside h1", () => {
    const md = "# Parent\nParent content.\n## Child\nChild content.";
    const xml = markdownToXml(md);
    expect(xml).toContain("<parent>");
    expect(xml).toContain("<child>");
    expect(xml).toContain("Child content.");
    expect(xml).toContain("</child>");
    expect(xml).toContain("</parent>");
  });

  test("nests h3 inside h2 inside h1", () => {
    const md =
      "# Top\nTop text.\n## Mid\nMid text.\n### Deep\nDeep text.";
    const xml = markdownToXml(md);
    const topOpen = xml.indexOf("<top>");
    const midOpen = xml.indexOf("<mid>");
    const deepOpen = xml.indexOf("<deep>");
    const deepClose = xml.indexOf("</deep>");
    const midClose = xml.indexOf("</mid>");
    const topClose = xml.indexOf("</top>");

    expect(topOpen).toBeLessThan(midOpen);
    expect(midOpen).toBeLessThan(deepOpen);
    expect(deepClose).toBeLessThan(midClose);
    expect(midClose).toBeLessThan(topClose);
  });

  test("closes deeper tags when a shallower heading appears", () => {
    const md = "# First\n## Nested\nContent.\n# Second\nMore content.";
    const xml = markdownToXml(md);
    const nestedClose = xml.indexOf("</nested>");
    const firstClose = xml.indexOf("</first>");
    const secondOpen = xml.indexOf("<second>");
    expect(nestedClose).toBeLessThan(firstClose);
    expect(firstClose).toBeLessThan(secondOpen);
  });

  test("wraps content before first heading in preamble", () => {
    const md = "Some preamble text.\n# Heading\nBody.";
    const xml = markdownToXml(md);
    expect(xml).toContain("<preamble>");
    expect(xml).toContain("Some preamble text.");
    expect(xml).toContain("</preamble>");
  });

  test("wraps entire content in preamble when no headings exist", () => {
    const md = "Just some text.\nAnother line.";
    const xml = markdownToXml(md);
    expect(xml).toContain("<preamble>");
    expect(xml).toContain("Just some text.");
    expect(xml).toContain("Another line.");
    expect(xml).toContain("</preamble>");
  });

  test("slugifies heading text to tag names", () => {
    const md = "# Code Quality & Style\nContent.";
    const xml = markdownToXml(md);
    expect(xml).toContain("<code_quality_style>");
  });

  test("handles multiple sibling h1 sections", () => {
    const md = "# Alpha\nA content.\n# Beta\nB content.\n# Gamma\nG content.";
    const xml = markdownToXml(md);
    // Each section should be self-contained
    expect(xml).toContain("<alpha>");
    expect(xml).toContain("</alpha>");
    expect(xml).toContain("<beta>");
    expect(xml).toContain("</beta>");
    expect(xml).toContain("<gamma>");
    expect(xml).toContain("</gamma>");
    // Alpha closes before Beta opens
    expect(xml.indexOf("</alpha>")).toBeLessThan(xml.indexOf("<beta>"));
  });

  test("handles empty sections", () => {
    const md = "# Empty\n# Next\nHas content.";
    const xml = markdownToXml(md);
    expect(xml).toContain("<empty>");
    expect(xml).toContain("</empty>");
    expect(xml).toContain("<next>");
    expect(xml).toContain("Has content.");
  });

  test("handles empty document", () => {
    const xml = markdownToXml("");
    // Should produce something without crashing
    expect(typeof xml).toBe("string");
  });

  test("preserves blank lines within sections", () => {
    const md = "# Section\nLine one.\n\nLine two.";
    const xml = markdownToXml(md);
    expect(xml).toContain("Line one.\n\nLine two.");
  });

  test("lowercases tag names", () => {
    const md = "# ALL CAPS HEADING\nContent.";
    const xml = markdownToXml(md);
    expect(xml).toContain("<all_caps_heading>");
  });

  test("handles h2 without parent h1", () => {
    const md = "## Orphan\nOrphan content.";
    const xml = markdownToXml(md);
    expect(xml).toContain("<orphan>");
    expect(xml).toContain("Orphan content.");
    expect(xml).toContain("</orphan>");
  });
});

describe("toAnthropicXml", () => {
  test("injects environment block", () => {
    const md = "# Identity and Voice\nBe direct.";
    const xml = toAnthropicXml(md);
    expect(xml).toContain("<environment>");
    expect(xml).toContain("mimir-acp");
    expect(xml).toContain("</environment>");
  });

  test("injects model override block", () => {
    const md = "# Identity and Voice\nBe direct.";
    const xml = toAnthropicXml(md);
    expect(xml).toContain("<model_override>");
    expect(xml).toContain("You are Mimir, not Claude");
    expect(xml).toContain("</model_override>");
  });

  test("places injections before identity_and_voice tag", () => {
    const md =
      "# Critical Rules\nRules here.\n# Identity and Voice\nVoice here.";
    const xml = toAnthropicXml(md);
    const envIdx = xml.indexOf("<environment>");
    const overrideIdx = xml.indexOf("<model_override>");
    const identityIdx = xml.indexOf("<identity_and_voice>");
    expect(envIdx).toBeLessThan(identityIdx);
    expect(overrideIdx).toBeLessThan(identityIdx);
    expect(envIdx).toBeLessThan(overrideIdx);
  });

  test("falls back to appending when identity_and_voice is missing", () => {
    const md = "# Other Section\nContent.";
    const xml = toAnthropicXml(md);
    expect(xml).toContain("<environment>");
    expect(xml).toContain("<model_override>");
    expect(xml).toContain("</other_section>");
  });

  test("preserves the original markdown content in XML form", () => {
    const md = "# Rules\nFollow these rules.\n## Sub Rule\nDo this.";
    const xml = toAnthropicXml(md);
    expect(xml).toContain("Follow these rules.");
    expect(xml).toContain("Do this.");
  });

  test("environment block describes MCP tool name mapping", () => {
    const md = "# Identity and Voice\nVoice.";
    const xml = toAnthropicXml(md);
    expect(xml).toContain("mcp__mimir__");
    expect(xml).toContain("mcp__context7__");
  });

  test("model override suppresses Claude personality patterns", () => {
    const md = "# Identity and Voice\nVoice.";
    const xml = toAnthropicXml(md);
    expect(xml).toContain("suppress them completely");
    expect(xml).toContain("Mimir acts or states");
  });

  test("identity_and_voice content is preserved after injection", () => {
    const md =
      "# Identity and Voice\nMimir speaks with dry wit and precision.";
    const xml = toAnthropicXml(md);
    const identityIdx = xml.indexOf("<identity_and_voice>");
    const content = xml.slice(identityIdx);
    expect(content).toContain("Mimir speaks with dry wit and precision.");
    expect(content).toContain("</identity_and_voice>");
  });
});
