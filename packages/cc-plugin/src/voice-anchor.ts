/**
 * Voice anchors — periodic persona refresh for Claude Code under Mimir.
 *
 * Wired as a UserPromptSubmit hook by the installer. Reads the hook payload
 * from stdin, increments per-session turn count, and on a fixed cadence
 * prepends a `<voice_anchor>` block (a dialogue exchange from the system
 * prompt's voice library) to the developer's prompt.
 *
 * Anthropic models drift off the system-prompt persona as conversations
 * lengthen. The system prompt holds the primacy slot; the most recent user
 * message holds the recency slot. Voice anchors occupy the recency slot.
 *
 * Adapted from the mimir monorepo (packages/acp/src/backends/claude-code/
 * voice-anchors.ts). Source-of-truth difference: the on-disk prompt is the
 * XML-converted version, so the parser hunts for the `<voice_in_action>`
 * tag rather than the `## Voice in Action` markdown heading. The inner
 * format (`**Title:**` lines followed by blockquote bodies) is preserved
 * verbatim by markdownToXml, so the body parser is unchanged.
 */

import { join } from "node:path";

import { assembleBootContext } from "./boot-context";
import { createLogger } from "./logger";
import { errMessage, mimirHome } from "./util";

const log = createLogger("voice-anchor");

type VoiceAnchor = {
  readonly title: string;
  readonly body: string;
};

type VoiceAnchorState = {
  readonly turnCount: number;
  readonly lastAnchorTurn: number;
  readonly anchorIndex: number;
};

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly prompt?: string;
  readonly cwd?: string;
};

const VOICE_IN_ACTION_BLOCK = /<voice_in_action>([\s\S]*?)<\/voice_in_action>/;
const TITLE_LINE = /^\*\*(.+?):\*\*\s*$/;
const QUOTE_LINE = /^>\s?(.*)$/;

/**
 * Extract dialogue exchanges from the converted system prompt.
 *
 * Locates the `<voice_in_action>...</voice_in_action>` block, then parses
 * `**Title:**` + blockquote pairs inside it. Blockquotes may contain a
 * single Mimir line or a Developer/Mimir pair separated by a bare `>`.
 *
 * Throws loudly if the block can't be located — a malformed prompt should
 * fail at hook invocation rather than silently disable anchors.
 */
export const parseVoiceAnchors = (xml: string): VoiceAnchor[] => {
  const blockMatch = VOICE_IN_ACTION_BLOCK.exec(xml);
  if (!blockMatch) {
    throw new Error(
      "Voice anchors: '<voice_in_action>' block not found in system prompt. " +
        "Confirm the prompt was converted via toAnthropicXml at install time.",
    );
  }

  const sectionBody = blockMatch[1] ?? "";

  const anchors: VoiceAnchor[] = [];
  let currentTitle: string | null = null;
  let currentBody: string[] = [];
  let inQuote = false;

  const flush = () => {
    if (currentTitle !== null && currentBody.length > 0) {
      const body = currentBody.join("\n").replace(/^\s+|\s+$/g, "");
      if (body.length > 0) {
        anchors.push({ title: currentTitle, body });
      }
    }
    currentTitle = null;
    currentBody = [];
    inQuote = false;
  };

  for (const line of sectionBody.split("\n")) {
    const titleMatch = TITLE_LINE.exec(line);
    if (titleMatch) {
      flush();
      currentTitle = titleMatch[1] ?? "";
      continue;
    }

    const quoteMatch = QUOTE_LINE.exec(line);
    if (quoteMatch && currentTitle !== null) {
      currentBody.push(quoteMatch[1] ?? "");
      inQuote = true;
      continue;
    }

    if (inQuote && line.trim() === "") {
      inQuote = false;
    }
  }
  flush();

  return anchors;
};

/**
 * Deterministic FNV-1a 32-bit hash → offset. Ensures different sessions
 * start at different points in the rotation so short sessions don't all
 * see the same first anchor.
 */
const hashSessionStart = (sessionId: string, libSize: number) => {
  if (libSize <= 0) return 0;
  let h = 2166136261;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % libSize;
};

const createAnchorState = (
  sessionId: string,
  libSize: number,
): VoiceAnchorState => ({
  turnCount: 0,
  lastAnchorTurn: 0,
  anchorIndex: hashSessionStart(sessionId, libSize),
});

type AnchorStep =
  | { readonly inject: false; readonly next: VoiceAnchorState }
  | {
      readonly inject: true;
      readonly anchor: VoiceAnchor;
      readonly next: VoiceAnchorState;
    };

/**
 * Advance one developer-initiated turn and decide whether to inject.
 *
 * Returns the next state unconditionally (turnCount always ticks) and an
 * anchor when `(turnCount - lastAnchorTurn) >= interval`.
 */
const nextAnchor = (
  state: VoiceAnchorState,
  library: readonly VoiceAnchor[],
  interval: number,
): AnchorStep => {
  const turnCount = state.turnCount + 1;
  const shouldInject =
    library.length > 0 && turnCount - state.lastAnchorTurn >= interval;

  if (!shouldInject) {
    return {
      inject: false,
      next: {
        turnCount,
        lastAnchorTurn: state.lastAnchorTurn,
        anchorIndex: state.anchorIndex,
      },
    };
  }

  const index = state.anchorIndex % library.length;
  const anchor = library[index];
  if (!anchor) {
    return {
      inject: false,
      next: {
        turnCount,
        lastAnchorTurn: state.lastAnchorTurn,
        anchorIndex: state.anchorIndex,
      },
    };
  }

  return {
    inject: true,
    anchor,
    next: {
      turnCount,
      lastAnchorTurn: turnCount,
      anchorIndex: (index + 1) % library.length,
    },
  };
};

const formatAnchor = (anchor: VoiceAnchor) =>
  `<voice_anchor>\n${anchor.body}\n</voice_anchor>`;

const readStdin = async (): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  return buf.toString("utf8");
};

const safeParseHookInput = (raw: string): HookInput => {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
};

const loadState = async (
  path: string,
  sessionId: string,
  libSize: number,
): Promise<VoiceAnchorState> => {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return createAnchorState(sessionId, libSize);
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
  return createAnchorState(sessionId, libSize);
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
  const stateDir = join(home, "voice-state");
  const statePath = join(stateDir, `${sessionId}.json`);

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
