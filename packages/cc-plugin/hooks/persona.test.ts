import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

const HOME = "/home/t";
const PERSONA_XML = "<persona>Mimir</persona>";

const compose = {
  model: "claude",
  promptModel: "claude",
  surfaces: [],
  tools: [],
  outputStyle: null,
  traits: [],
} as const;

const engineSection = (id: string, scope: "shared" | "session" = "session") =>
  ({ id, text: `engine:${id}`, scope }) as const;

const PERSONA_SECTION = {
  id: "mimir-cc:persona",
  text: PERSONA_XML,
  scope: "session",
} as const;

test("the persona replaces the engine's prompt, keeping only the sections it has no answer for", async ($, on) => {
  mock.env(on, { HOME });
  on("fs.exists", (_, e) => ({
    value: e.path === `${HOME}/.mimir/cc/system-prompt.xml`,
  }));
  on("fs.read", () => ({ value: PERSONA_XML }));
  on("prompt.compose", () => ({
    sections: [
      engineSection("lean_body", "shared"),
      engineSection("pronouns"),
      engineSection("user_privacy"),
      engineSection("session_guidance"),
      engineSection("memory"),
      engineSection("env_info_simple"),
      engineSection("context_management"),
    ],
  }));

  const { sections } = await $.prompt.compose(compose);

  // In the engine's order, and the persona last: its identity section is
  // the last thing the model reads.
  expect(sections).toEqual([
    engineSection("user_privacy"),
    engineSection("session_guidance"),
    engineSection("context_management"),
    PERSONA_SECTION,
  ]);
});

test("a section the engine adds for the plugin's output style is dropped, so the persona goes out once", async ($, on) => {
  const STYLE_SECTION = {
    id: "output_style",
    text: PERSONA_XML,
    scope: "session",
  } as const;
  mock.env(on, { HOME });
  on("fs.exists", (_, e) => ({
    value: e.path === `${HOME}/.mimir/cc/system-prompt.xml`,
  }));
  on("fs.read", () => ({ value: PERSONA_XML }));
  on("prompt.compose", () => ({
    sections: [
      engineSection("user_privacy"),
      STYLE_SECTION,
      engineSection("session_guidance"),
      engineSection("context_management"),
    ],
  }));

  const { sections } = await $.prompt.compose(compose);

  expect(sections).toEqual([
    engineSection("user_privacy"),
    engineSection("session_guidance"),
    engineSection("context_management"),
    PERSONA_SECTION,
  ]);
  expect(sections.filter((s) => s.text.includes(PERSONA_XML))).toHaveLength(1);
});

test("an engine that offers none of those sections leaves the persona alone", async ($, on) => {
  mock.env(on, { HOME });
  on("fs.exists", (_, e) => ({
    value: e.path === `${HOME}/.mimir/cc/system-prompt.xml`,
  }));
  on("fs.read", () => ({ value: PERSONA_XML }));
  on("prompt.compose", () => ({
    sections: [engineSection("intro", "shared"), engineSection("tone")],
  }));

  const { sections } = await $.prompt.compose(compose);

  expect(sections).toEqual([PERSONA_SECTION]);
});

test("falls back to the canonical markdown when the XML is absent", async ($, on) => {
  mock.env(on, { HOME });
  on("fs.exists", (_, e) => ({
    value: e.path === `${HOME}/.mimir/system-prompt.md`,
  }));
  on("fs.read", (_, e) => ({ value: `md:${e.path}` }));
  on("prompt.compose", () => ({ sections: [] }));

  const { sections } = await $.prompt.compose(compose);

  expect(sections.at(-1)?.text).toBe(`md:${HOME}/.mimir/system-prompt.md`);
});

test("hands the prompt back to the engine when no persona is installed", async ($, on) => {
  mock.env(on, { HOME });
  on("fs.exists", () => ({ value: false }));
  on("ui.status", () => ({ value: undefined }));
  on("prompt.compose", () => ({
    sections: [{ id: "intro", text: "engine", scope: "shared" as const }],
  }));

  const { sections } = await $.prompt.compose(compose);

  expect(sections).toEqual([{ id: "intro", text: "engine", scope: "shared" }]);
});

const STYLE_ATTACHMENT = "output_style_instructions";
const PLUGIN_STYLE_TEXT = `# Output Style: mimir-cc:Mimir\n${PERSONA_XML}`;

const attachment = (type: string, text: string) => ({
  type,
  text,
  origin: { kind: "engine" as const },
});

/** The engine's answer to an attachment no hook touched: its own text. */
const passThrough = (on: On) => {
  on("prompt.attachment", (_, e) => ({ text: e.text }));
};

const personaInstalled = (on: On) => {
  mock.env(on, { HOME });
  on("fs.exists", (_, e) => ({
    value: e.path === `${HOME}/.mimir/cc/system-prompt.xml`,
  }));
  on("fs.read", () => ({ value: PERSONA_XML }));
  on("prompt.compose", () => ({ sections: [] }));
};

test("once the persona is composed, the plugin's output style attachment is left out", async ($, on) => {
  personaInstalled(on);
  passThrough(on);
  await $.prompt.compose(compose);

  expect(
    await $.prompt.attachment(attachment(STYLE_ATTACHMENT, PLUGIN_STYLE_TEXT)),
  ).toEqual({ text: null });
});

test("another style's output style attachment passes through", async ($, on) => {
  const text = "# Output Style: Explanatory\nExplain your choices.";
  personaInstalled(on);
  passThrough(on);
  await $.prompt.compose(compose);

  expect(await $.prompt.attachment(attachment(STYLE_ATTACHMENT, text))).toEqual(
    { text },
  );
});

test("an attachment of another type passes through, even under the style's heading", async ($, on) => {
  personaInstalled(on);
  passThrough(on);
  await $.prompt.compose(compose);

  expect(
    await $.prompt.attachment(attachment("nested_memory", PLUGIN_STYLE_TEXT)),
  ).toEqual({ text: PLUGIN_STYLE_TEXT });
});

test("when the persona could not be read, the plugin's style attachment passes through", async ($, on) => {
  mock.env(on, { HOME });
  on("fs.exists", () => ({ value: false }));
  on("ui.status", () => ({ value: undefined }));
  on("prompt.compose", () => ({ sections: [] }));
  passThrough(on);
  await $.prompt.compose(compose);

  expect(
    await $.prompt.attachment(attachment(STYLE_ATTACHMENT, PLUGIN_STYLE_TEXT)),
  ).toEqual({ text: PLUGIN_STYLE_TEXT });
});

test("before any compose, the plugin's style attachment passes through", async ($, on) => {
  personaInstalled(on);
  passThrough(on);

  expect(
    await $.prompt.attachment(attachment(STYLE_ATTACHMENT, PLUGIN_STYLE_TEXT)),
  ).toEqual({ text: PLUGIN_STYLE_TEXT });
});
