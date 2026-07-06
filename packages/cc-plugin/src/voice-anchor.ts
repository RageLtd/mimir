/**
 * Voice anchors — periodic persona refresh for Claude Code under Mimir.
 *
 * Wired as a UserPromptSubmit hook by the installer. Reads the hook payload
 * from stdin, increments per-session turn count, and on a fixed cadence
 * prepends a `<voice_anchor>` block (a dialogue exchange from the system
 * prompt's voice library) to the developer's prompt.
 *
 * The pure parser/rotation/format logic lives in
 * `@mimir/plugin-core/voice-anchor`; this file is the CC-specific hook
 * glue (stdin/stdout protocol, MIMIR_ACTIVE gating, boot-context
 * integration on the first turn).
 *
 * Anthropic models drift off the system-prompt persona as conversations
 * lengthen. The system prompt holds the primacy slot; the most recent user
 * message holds the recency slot. Voice anchors occupy the recency slot.
 */

import { join } from "node:path";
import { errMessage, mimirHome } from "@mimir/plugin-core/util";
import {
  type VoiceAnchor as Anchor,
  createSessionVoiceAnchor,
  formatAnchor,
  nextAnchor,
  parseVoiceAnchors,
  type VoiceAnchorState,
} from "@mimir/plugin-core/voice-anchor";
import { assembleBootContext } from "./boot-context";
import { createLogger } from "./logger";

const log = createLogger("voice-anchor");

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly prompt?: string;
  readonly cwd?: string;
};

const readStdin = async (): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const safeParseHookInput = (raw: string): HookInput => {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
};

const voiceStateDir = () => join(mimirHome(), "voice-state");
const voiceStatePath = (sessionId: string) =>
  join(voiceStateDir(), `${sessionId}.json`);

const loadState = async (
  path: string,
  sessionId: string,
  libSize: number,
): Promise<VoiceAnchorState> => {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return createSessionVoiceAnchor(sessionId, libSize);
  }
  try {
    const parsed = (await file.json()) as Partial<VoiceAnchorState>;
    if (
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
  } catch {
    // fall through to fresh state
  }
  return createSessionVoiceAnchor(sessionId, libSize);
};

const saveState = async (path: string, state: VoiceAnchorState) => {
  await Bun.write(path, JSON.stringify(state));
};

/**
 * Entry point invoked from cli.ts when argv[2] === "voice-anchor".
 *
 * Defence-in-depth: silently no-op when MIMIR_ACTIVE !== "1" — the wrapper
 * script exports that flag, and settings.json scoping already restricts the
 * hook to mimir sessions, but a nested `claude` subprocess inside a mimir
 * session would otherwise inherit the same settings file.
 */
export const runVoiceAnchorHook = async (): Promise<number> => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const raw = await readStdin();
  const input = safeParseHookInput(raw);
  const sessionId = input.session_id ?? "default";

  const home = mimirHome();
  const promptPath = join(home, "system-prompt.md");
  const statePath = voiceStatePath(sessionId);

  const promptFile = Bun.file(promptPath);
  if (!(await promptFile.exists())) {
    // No prompt installed — nothing to inject from. Exit silently rather
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

export type { Anchor };
