/**
 * The Mimir persona as the session's system prompt.
 *
 * Answers `prompt.compose` with its own list, so the engine's sections do
 * not go out — the same replacement the wrapper's `--system-prompt-file`
 * made, now for every host the plugin loads in (terminal, desktop app,
 * SDK) with no flag.
 *
 * The plugin also ships the persona as a forced output style
 * (`output-styles/mimir.md`), which carries it where an organization
 * passes this plugin's hooks over. The engine sends a style not as a
 * section but as an `output_style_instructions` attachment headed
 * `# Output Style: <plugin>:Mimir`, so `prompt.compose` cannot drop it;
 * `prompt.attachment` leaves it out once this hook has composed the
 * persona, and only then, so the persona goes out once.
 *
 * Three of the engine's sections are kept, because the persona has no
 * answer for them and the engine keeps them current with each release
 * (KEPT_SECTIONS). They go first and the persona last: its identity
 * section is the last thing the model reads. A section the engine does
 * not offer is simply absent; one it adds later is dropped until it is
 * named here.
 *
 * Mimir's own rules ride in a section of their own, just ahead of the
 * persona. An install writes them to ~/.mimir/rules; the engine loads a
 * project's rule files itself but knows nothing of that directory, so on
 * this host they reach the model here or not at all.
 *
 * The persona and the rules are read once per load; the module's
 * variables reset on a hot reload, which is when a re-read is wanted.
 */

import type {
  EngineInterface,
  PromptComposeSection,
  Register,
} from "claude-code";

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

/**
 * The installed rule files as one text, in name order; empty when there
 * are none, as before the first update that writes them.
 */
const readRules = async ($: EngineInterface) => {
  const dir = `${(await $.env.get("HOME")) ?? ""}/.mimir/rules`;
  if (!(await $.fs.exists(dir))) return "";
  const names = (await $.fs.list(dir))
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".md"))
    .sort();
  const texts = await Promise.all(
    names.map((name) => $.fs.read(`${dir}/${name}`)),
  );
  return texts.map((text) => text.trim()).join("\n\n");
};

/** The engine's attachment type for an output style's text. */
const STYLE_ATTACHMENT = "output_style_instructions";

/** `name` in output-styles/mimir.md; the engine prefixes the plugin's. */
const STYLE_NAME = "Mimir";

export const registerPersona: Register = (on) => {
  let persona: string | null = null;
  let rules: string | null = null;
  let composed = false;

  on("prompt.compose", async ($, e, next) => {
    composed = false;
    persona ??= await readPersona($);
    // Caught here and not by the handler's own catch, which would drop
    // the persona along with the rules.
    rules ??= await readRules($).catch((err: unknown) => {
      $.ui.status(
        `mimir: rules unavailable — ${err instanceof Error ? err.message : String(err)}`,
      );
      return "";
    });
    const engine = await next(e);
    composed = true;
    const rulesSections: PromptComposeSection[] = rules
      ? [{ id: `${$.plugin.name}:rules`, text: rules, scope: "session" }]
      : [];
    return {
      sections: [
        ...engine.sections.filter((section) =>
          KEPT_SECTIONS.includes(section.id),
        ),
        ...rulesSections,
        { id: `${$.plugin.name}:persona`, text: persona, scope: "session" },
      ],
    };
  }).catch(($, e, next) => {
    $.ui.status("mimir: persona unavailable — running as plain Claude Code");
    return next(e);
  });

  on("prompt.attachment", { type: STYLE_ATTACHMENT }, ($, e, next) =>
    composed &&
    e.text.startsWith(`# Output Style: ${$.plugin.name}:${STYLE_NAME}\n`)
      ? { text: null }
      : next(e),
  );
};
