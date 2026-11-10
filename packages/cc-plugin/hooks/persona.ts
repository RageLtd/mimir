/**
 * The Mimir persona as the session's system prompt.
 *
 * Answers `prompt.compose` with its own list, so the engine's sections do
 * not go out — the same replacement the wrapper's `--system-prompt-file`
 * made, now for every host the plugin loads in (terminal, desktop app,
 * SDK) with no output style and no flag.
 *
 * Three of the engine's sections are kept, because the persona has no
 * answer for them and the engine keeps them current with each release
 * (KEPT_SECTIONS). They go first and the persona last: its identity
 * section is the last thing the model reads. A section the engine does
 * not offer is simply absent; one it adds later is dropped until it is
 * named here.
 *
 * The persona is read once per load from the installed XML; the module's
 * variable resets on a hot reload, which is when a re-read is wanted.
 */

import type { EngineInterface, Register } from "claude-code";

/** In preference order; the first that exists wins. */
const PERSONA_CANDIDATES = ["cc/system-prompt.xml", "system-prompt.md"];

/**
 * The engine's sections the persona rides with, by id:
 * - `user_privacy`: keep the developer's name, project and details out of
 *   requests to outside services. Mimir carries a profile and a replica
 *   into every session, and its memory split governs storage, not egress.
 * - `session_guidance`: how a typed `/<skill-name>` is invoked.
 * - `context_management`: a long conversation is summarised, so there is
 *   no need to wrap up early.
 */
const KEPT_SECTIONS: readonly string[] = [
  "user_privacy",
  "session_guidance",
  "context_management",
];

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

  on("prompt.compose", async ($, e, next) => {
    persona ??= await readPersona($);
    const engine = await next(e);
    return {
      sections: [
        ...engine.sections.filter((section) =>
          KEPT_SECTIONS.includes(section.id),
        ),
        { id: `${$.plugin.name}:persona`, text: persona, scope: "session" },
      ],
    };
  }).catch(($, e, next) => {
    $.ui.status("mimir: persona unavailable — running as plain Claude Code");
    return next(e);
  });
};
