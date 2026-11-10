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
