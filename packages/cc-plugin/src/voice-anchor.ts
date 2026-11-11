/**
 * `mimir-cc voice-anchor --session <id> --nth <n>` — the n-th voice
 * anchor of a session's rotation, printed as a `<voice_anchor>` block.
 *
 * The hooks module owns the turn counter (`$.state`) and the cadence;
 * the binary owns the library (parsed from the installed persona) and
 * the rotation: a per-session start offset (a hash of the session id,
 * so short sessions don't all open on the same exchange) plus n, modulo
 * the library. Deterministic, so the binary keeps no state. The pure
 * parse/rotation/format logic lives in @mimir/plugin-core/voice-anchor.
 *
 * Anthropic models drift off the system-prompt persona as conversations
 * lengthen. The system prompt holds the primacy slot; the most recent
 * user message holds the recency slot. Voice anchors occupy the recency
 * slot.
 */

import { join } from "node:path";
import { attempt } from "@mimir/plugin-core/result";
import { errMessage, mimirHome } from "@mimir/plugin-core/util";
import {
  createSessionVoiceAnchor,
  formatAnchor,
  parseVoiceAnchors,
  type VoiceAnchor,
} from "@mimir/plugin-core/voice-anchor";
import { createLogger } from "./logger";

const log = createLogger("voice-anchor");

export const parseAnchorArgs = (rest: readonly string[]) => {
  let session: string | undefined;
  let nth: number | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined) return { error: `${flag} requires a value` };
    if (flag === "--session") session = value;
    else if (flag === "--nth") nth = Number.parseInt(value, 10);
    else return { error: `unknown flag: ${flag}` };
  }
  if (session === undefined || nth === undefined || !(nth >= 0)) {
    return { error: "voice-anchor needs --session <id> and --nth <n>" };
  }
  return { session, nth };
};

/** The n-th anchor of a session's rotation; null when there are none. */
export const anchorFor = (
  library: readonly VoiceAnchor[],
  session: string,
  nth: number,
) => {
  if (library.length === 0) return null;
  const start = createSessionVoiceAnchor(session, library.length).anchorIndex;
  return library[(start + nth) % library.length] ?? null;
};

export const runVoiceAnchorCommand = async (rest: readonly string[]) => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const args = parseAnchorArgs(rest);
  if ("error" in args) {
    console.error(args.error);
    return 1;
  }

  // No persona installed — nothing to anchor to; not an error.
  const promptFile = Bun.file(join(mimirHome(), "system-prompt.md"));
  if (!(await promptFile.exists())) return 0;

  const [parseErr, library] = await attempt(async () =>
    parseVoiceAnchors(await promptFile.text()),
  );
  if (parseErr) {
    log.error("voice anchor parse failed", { error: errMessage(parseErr) });
    return 1;
  }

  const anchor = anchorFor(library, args.session, args.nth);
  if (anchor) process.stdout.write(formatAnchor(anchor));
  return 0;
};
