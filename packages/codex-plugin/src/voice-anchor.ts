/**
 * Voice anchors — periodic persona refresh for Codex under Mimir
 * (ported from cc-plugin).
 *
 * Wired as a UserPromptSubmit hook by the installer. Reads the hook
 * payload from stdin, increments per-session turn count, and on a fixed
 * cadence prepends a `<voice_anchor>` block (a dialogue exchange from
 * the persona's voice library) to the developer's prompt.
 *
 * The persona lives at $CODEX_HOME/AGENTS.md (the installer writes the
 * same toAnthropicXml output cc-plugin uses, so parseVoiceAnchors works
 * unmodified). The system prompt holds the primacy slot; the most recent
 * user message holds the recency slot. Voice anchors occupy the recency
 * slot.
 *
 * First-turn detection doubles as the boot-context injection point —
 * same contract as cc-plugin's voice-anchor.
 */

import { join } from "node:path";
import { assembleBootContext } from "@mimir/plugin-core/brain/boot-context";
import { errMessage, mimirHome } from "@mimir/plugin-core/util";
import {
  createSessionVoiceAnchor,
  formatAnchor,
  nextAnchor,
  parseVoiceAnchors,
  type VoiceAnchorState,
} from "@mimir/plugin-core/voice-anchor";
import { readHookInput } from "./hook-input";
import { createLogger } from "./logger";
import { mimirCodexHome } from "./paths";

const log = createLogger("voice-anchor");

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly prompt?: string;
  readonly cwd?: string;
};

const personaPath = () => join(mimirCodexHome(), "AGENTS.md");

const voiceStateDir = () => join(mimirHome(), "voice-state");
const voiceStatePath = (sessionId: string) =>
  join(voiceStateDir(), `${sessionId}.json`);

const loadState = async (path: string, sessionId: string, libSize: number) => {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return createSessionVoiceAnchor(sessionId, libSize);
  }
  const parsed = (await file
    .json()
    .catch(() => null)) as Partial<VoiceAnchorState> | null;
  if (
    parsed &&
    typeof parsed.turnCount === "number" &&
    typeof parsed.lastAnchorTurn === "number" &&
    typeof parsed.anchorIndex === "number"
  ) {
    return {
      turnCount: parsed.turnCount,
      lastAnchorTurn: parsed.lastAnchorTurn,
      anchorIndex: parsed.anchorIndex,
    };
  }
  return createSessionVoiceAnchor(sessionId, libSize);
};

const saveState = async (path: string, state: VoiceAnchorState) => {
  await Bun.write(path, JSON.stringify(state));
};

/**
 * Entry point invoked from cli.ts when argv[2] === "voice-anchor".
 *
 * Defence-in-depth: silently no-op when MIMIR_ACTIVE !== "1" — the
 * wrapper script exports that flag; a hook fired from a codex process
 * that isn't a mimir session must not inject.
 */
export const runVoiceAnchorHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const input = await readHookInput<HookInput>();
  const sessionId = input.session_id ?? "default";

  const statePath = voiceStatePath(sessionId);

  const promptFile = Bun.file(personaPath());
  if (!(await promptFile.exists())) {
    // No persona installed — nothing to inject from. Exit silently rather
    // than blocking the user's turn.
    return 0;
  }

  const promptText = await promptFile.text();
  const library = parseVoiceAnchors(promptText);
  if (library.length === 0) return 0;

  const intervalEnv = process.env.MIMIR_ANCHOR_INTERVAL;
  const parsedInterval = intervalEnv ? Number.parseInt(intervalEnv, 10) : 5;
  const interval =
    Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 5;

  const state = await loadState(statePath, sessionId, library.length);

  // First-turn detection: a state with turnCount === 0 means this is the
  // first developer prompt for this session — emit the boot-context block
  // (user profile + prior session context) BEFORE the voice anchor logic
  // so the model reads it as the leading content of its first user turn.
  // Voice anchor itself never fires on turn 1 (interval defaults to 5),
  // so the two never compete for the same prompt.
  if (state.turnCount === 0) {
    const boot = await assembleBootContext({
      promptText: input.prompt ?? "",
      projectPath: input.cwd ?? process.cwd(),
      log,
    }).catch((err) => {
      log.error("assembleBootContext threw", { error: errMessage(err) });
      return null;
    });
    if (boot) {
      process.stdout.write(`${boot}\n\n`);
    }
  }

  const step = nextAnchor(state, library, interval);
  await saveState(statePath, step.next);

  if (step.inject) {
    process.stdout.write(formatAnchor(step.anchor));
  }

  return 0;
};
