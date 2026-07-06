/**
 * Voice anchor — pure logic for periodic persona refresh.
 *
 * Originally in packages/cc-plugin/src/voice-anchor.ts; lifted into the
 * shared layer because every Mimir adapter (CC plugin, future OC
 * plugin) needs the same parse-rotation-format pipeline against the
 * persona system prompt's `<voice_in_action>` block. The hook-specific
 * glue (stdin/stdout protocol, MIMIR_ACTIVE gating) stays in the
 * adapter; this module is host-agnostic.
 *
 * Anthropic models drift off the system-prompt persona as conversations
 * lengthen. The system prompt holds the primacy slot; the most recent
 * user message holds the recency slot. Voice anchors occupy the recency
 * slot, sampled on a fixed cadence (default every 5 turns, override
 * via `MIMIR_ANCHOR_INTERVAL`).
 */

const VOICE_IN_ACTION_BLOCK = /<voice_in_action>([\s\S]*?)<\/voice_in_action>/;
const TITLE_LINE = /^\*\*(.+?):\*\*\s*$/;
const QUOTE_LINE = /^>\s?(.*)$/;

export type VoiceAnchor = {
  readonly title: string;
  readonly body: string;
};

export type VoiceAnchorState = {
  readonly turnCount: number;
  readonly lastAnchorTurn: number;
  readonly anchorIndex: number;
};

export type AnchorStep =
  | { readonly inject: false; readonly next: VoiceAnchorState }
  | {
      readonly inject: true;
      readonly anchor: VoiceAnchor;
      readonly next: VoiceAnchorState;
    };

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

/**
 * Advance one developer-initiated turn and decide whether to inject.
 *
 * Returns the next state unconditionally (turnCount always ticks) and an
 * anchor when `(turnCount - lastAnchorTurn) >= interval`.
 */
export const nextAnchor = (
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

export const formatAnchor = (anchor: VoiceAnchor) =>
  `<voice_anchor>\n${anchor.body}\n</voice_anchor>`;

export const createSessionVoiceAnchor = (sessionId: string, libSize: number) =>
  createAnchorState(sessionId, libSize);
