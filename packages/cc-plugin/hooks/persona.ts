/**
 * The Mimir persona as the session's whole system prompt.
 *
 * Answers `prompt.compose` without `next`, so the engine's own sections
 * never go out — the same full replacement the wrapper's
 * `--system-prompt-file` made, now for every host the plugin loads in
 * (terminal, desktop app, SDK) with no output style and no flag.
 *
 * The persona is read once per load from the installed XML; the module's
 * variable resets on a hot reload, which is when a re-read is wanted.
 */

import type { EngineInterface, Register } from "claude-code";

/** In preference order; the first that exists wins. */
const PERSONA_CANDIDATES = ["cc/system-prompt.xml", "system-prompt.md"];

const readPersona = async ($: EngineInterface) => {
  const home = (await $.env.get("HOME")) ?? "";
  for (const candidate of PERSONA_CANDIDATES) {
    const path = `${home}/.mimir/${candidate}`;
    if (await $.fs.exists(path)) return $.fs.read(path);
  }
  throw new Error(
    `mimir-cc: no persona under ${home}/.mimir (run \`mimir-cc update\`)`,
  );
};

export const registerPersona: Register = (on) => {
  let persona: string | null = null;

  on("prompt.compose", async ($) => {
    persona ??= await readPersona($);
    return {
      sections: [
        { id: `${$.plugin.name}:persona`, text: persona, scope: "session" },
      ],
    };
  }).catch(($, e, next) => {
    $.ui.status("mimir: persona unavailable — running as plain Claude Code");
    return next(e);
  });
};
