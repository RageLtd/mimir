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

test("replaces the whole system prompt with the installed XML", async ($, on) => {
  mock.env(on, { HOME });
  on("fs.exists", (_, e) => ({
    value: e.path === `${HOME}/.mimir/cc/system-prompt.xml`,
  }));
  on("fs.read", () => ({ value: PERSONA_XML }));
  on("prompt.compose", () => {
    throw new Error("the engine's sections must not be composed");
  });

  const { sections } = await $.prompt.compose(compose);

  expect(sections).toEqual([
    { id: "mimir-cc:persona", text: PERSONA_XML, scope: "session" },
  ]);
});

test("falls back to the canonical markdown when the XML is absent", async ($, on) => {
  mock.env(on, { HOME });
  on("fs.exists", (_, e) => ({
    value: e.path === `${HOME}/.mimir/system-prompt.md`,
  }));
  on("fs.read", (_, e) => ({ value: `md:${e.path}` }));

  const { sections } = await $.prompt.compose(compose);

  expect(sections[0]?.text).toBe(`md:${HOME}/.mimir/system-prompt.md`);
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
