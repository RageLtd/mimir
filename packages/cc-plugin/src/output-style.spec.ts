import { describe, expect, test } from "bun:test";
import { toAnthropicXml } from "@mimir/plugin-core/anthropic-xml";
import { PROMPT_SEED } from "./agents";
import {
  OUTPUT_STYLE_DESCRIPTION,
  OUTPUT_STYLE_FILE,
  renderOutputStyle,
  renderSeedOutputStyle,
} from "./output-style";

const SEED =
  '# Working Rules\n\nRead first.\n\n# Identity and Voice\n\nMimir: a colon, a #hash and "quotes".\n';

/** Frontmatter between the opening and closing `---`, then a blank line,
 *  then the body, then one trailing newline — the agents' layout. */
const split = (md: string) => {
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)\n$/.exec(md);
  if (!match) throw new Error(`not a frontmatter document:\n${md}`);
  const [, frontmatter = "", body = ""] = match;
  return { frontmatter, body, data: Bun.YAML.parse(frontmatter) };
};

const ENVIRONMENT = /<environment>[\s\S]*?<\/environment>/;

/** The one `<environment>…</environment>` block of a converted prompt. */
const environmentOf = (xml: string) => {
  const match = ENVIRONMENT.exec(xml);
  if (!match) throw new Error(`no <environment> block in:\n${xml}`);
  return match[0];
};

const withoutEnvironment = (xml: string) => {
  environmentOf(xml);
  return xml.replace(ENVIRONMENT, "");
};

describe("renderOutputStyle", () => {
  test("frontmatter names the style Mimir, describes it on one line, and forces it for the plugin", () => {
    const { data } = split(renderOutputStyle(SEED));
    expect(data).toMatchObject({ name: "Mimir", "force-for-plugin": true });
    expect(OUTPUT_STYLE_DESCRIPTION.trim()).not.toBe("");
    expect(OUTPUT_STYLE_DESCRIPTION).not.toContain("\n");
    expect(data).toMatchObject({ description: OUTPUT_STYLE_DESCRIPTION });
  });

  test("carries no keep-coding-instructions key, so the engine's coding instructions stay out", () => {
    const { frontmatter, data } = split(renderOutputStyle(SEED));
    expect(frontmatter).not.toContain("keep-coding-instructions");
    expect(data).not.toHaveProperty("keep-coding-instructions");
  });

  test("the body is the installer's conversion of the seed but for its environment block", () => {
    const body = split(renderOutputStyle(SEED)).body;
    expect(environmentOf(body)).not.toBe(environmentOf(toAnthropicXml(SEED)));
    expect(withoutEnvironment(body)).toBe(
      withoutEnvironment(toAnthropicXml(SEED)),
    );
  });

  test("the environment block says the text arrives as an output style, not as the system prompt fetched from the server", () => {
    const environment = environmentOf(split(renderOutputStyle(SEED)).body);
    expect(environment).toMatch(/output style/i);
    expect(environment).not.toContain("as the session's system prompt");
    expect(environment).not.toContain("fetched from mimir-server");
  });

  test("the environment block keeps what the default says about the tools", () => {
    const environment = environmentOf(split(renderOutputStyle(SEED)).body);
    expect(environment).toContain("mimir-local");
    expect(environment).toContain("<system-reminder>");
  });

  test("the frontmatter parses back as YAML even when the description has a colon", () => {
    const description = 'Mimir: the persona, with a #hash and "quotes"';
    const { data } = split(renderOutputStyle(SEED, description));
    expect(data).toEqual({
      name: "Mimir",
      description,
      "force-for-plugin": true,
    });
  });
});

describe("seed output style", () => {
  test("the main session's prompt carries the Code Principles inside Required Patterns", async () => {
    const body = split(await renderSeedOutputStyle()).body;
    const patterns =
      /<required_patterns>[\s\S]*?<\/required_patterns>/.exec(body)?.[0] ?? "";
    const block =
      /<code_principles>([\s\S]*?)<\/code_principles>/.exec(patterns)?.[1] ??
      "";
    expect(block.trim()).not.toBe("");
    expect(block.match(/^[-*] /gm)?.length ?? 0).toBeGreaterThan(3);
  });

  test("the installed XML prompt carries them too", async () => {
    const xml = toAnthropicXml(await Bun.file(PROMPT_SEED).text());
    const patterns =
      /<required_patterns>[\s\S]*?<\/required_patterns>/.exec(xml)?.[0] ?? "";
    expect(patterns).toContain("<code_principles>");
  });
});

describe("committed output style", () => {
  test("output-styles/mimir.md matches the render of the seed — run `bun run output-style:render` if not", async () => {
    const seed = await Bun.file(PROMPT_SEED).text();
    expect(await renderSeedOutputStyle()).toBe(renderOutputStyle(seed));
    const committed = Bun.file(OUTPUT_STYLE_FILE);
    expect(OUTPUT_STYLE_FILE.endsWith("/output-styles/mimir.md")).toBe(true);
    expect(await committed.exists()).toBe(true);
    expect(await committed.text()).toBe(await renderSeedOutputStyle());
  });
});
