/**
 * Voice anchors — periodic persona refresh for the Anthropic backend.
 *
 * Anthropic models drift off the system-prompt persona as conversations
 * lengthen. The system prompt holds the primacy slot; the most recent user
 * message holds the recency slot. Voice anchors occupy the recency slot by
 * prepending a dialogue exchange from the system prompt's Voice in Action
 * section to the developer's user message on a counter-based cadence.
 *
 * Sourcing: the canonical system prompt is parsed at process startup. Every
 * change to the Voice in Action section flows through on next restart with
 * no separate hand-copied library to maintain.
 *
 * Gating: wrapper only runs on the Claude Code backend path. The mimir-server
 * backend (Qwen, GLM) doesn't need anchors and isn't wired through this path.
 */

export type VoiceAnchor = {
  /** Bold heading above the exchange, e.g. "Delivering bad news". */
  readonly title: string;
  /** Joined blockquote body, `> ` stripped. May contain Developer:/Mimir: lines or Mimir-only. */
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

const SECTION_HEADING = /^##\s+Voice in Action\s*$/m;
const NEXT_HEADING = /^##\s+/m;
const TITLE_LINE = /^\*\*(.+?):\*\*\s*$/;
const QUOTE_LINE = /^>\s?(.*)$/;

/**
 * Extract dialogue exchanges from a system prompt's Voice in Action section.
 * Each exchange is a `**Title:**` line followed by a blockquote. Blockquotes
 * may contain a single Mimir line or a Developer/Mimir pair separated by
 * a bare `>` blank line.
 *
 * Throws loudly if the section can't be located — a malformed prompt should
 * fail at startup rather than silently disable anchors.
 */
export const parseVoiceAnchors = (markdown: string): VoiceAnchor[] => {
  const headingMatch = SECTION_HEADING.exec(markdown);
  if (!headingMatch) {
    throw new Error(
      "Voice anchors: '## Voice in Action' heading not found in system prompt. " +
        "The parser requires that exact heading on its own line.",
    );
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const rest = markdown.slice(sectionStart);
  const endMatch = NEXT_HEADING.exec(rest);
  const sectionBody = endMatch ? rest.slice(0, endMatch.index) : rest;

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
      // A blank (non-quote) line terminates the quote. `>` inside the
      // blockquote — represented as a bare `>` — is handled by QUOTE_LINE
      // above and preserved as a blank body line.
      inQuote = false;
    }
  }
  flush();

  return anchors;
};

/** Wrap an anchor in the recognised container tag for recency-slot injection. */
export const formatAnchor = (anchor: VoiceAnchor) =>
  `<voice_anchor>\n${anchor.body}\n</voice_anchor>`;

/**
 * Deterministic FNV-1a 32-bit hash → offset. Ensures different sessions
 * start at different points in the rotation so short sessions don't all
 * see the same first anchor.
 */
export const hashSessionStart = (sessionId: string, libSize: number) => {
  if (libSize <= 0) return 0;
  let h = 2166136261;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % libSize;
};

export const createAnchorState = (sessionId: string, libSize: number) => ({
  turnCount: 0,
  lastAnchorTurn: 0,
  anchorIndex: hashSessionStart(sessionId, libSize),
});

/**
 * Advance one developer-initiated turn and decide whether to inject.
 *
 * Returns the next state unconditionally (turnCount always ticks) and an
 * anchor when `(turnCount - lastAnchorTurn) >= interval`. Call this once
 * per ACP prompt, never per SDK tool-result message.
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

/**
 * Advance the turn counter by an explicit weight. Used by the CC backend
 * to commit iteration-weighted turn advancement after the SDK loop ends —
 * a base tick of 1 was already applied by nextAnchor at turn start, so the
 * caller passes (cycles - 1) where cycles is the observed generation count.
 *
 * No-op when weight <= 0. Never touches lastAnchorTurn or anchorIndex — only
 * nextAnchor's injection decision updates those.
 */
export const advanceTurn = (state: VoiceAnchorState, weight: number) => {
  if (weight <= 0) return state;
  return {
    turnCount: state.turnCount + weight,
    lastAnchorTurn: state.lastAnchorTurn,
    anchorIndex: state.anchorIndex,
  };
};

/**
 * Default path to the canonical system prompt. Resolved from this file's
 * location so the acp package doesn't need to know its install root. Override
 * with MIMIR_SYSTEM_PROMPT_PATH in config if the monorepo layout changes.
 *
 * packages/acp/src/backends/claude-code → packages/server/system-prompt.md
 */
export const defaultSystemPromptPath = () =>
  `${import.meta.dir}/../../../../server/system-prompt.md`;

/**
 * Read and parse the system prompt from disk. Throws if the file is missing
 * or the Voice in Action section can't be located — loud failure by design.
 */
export const loadVoiceAnchors = async (filePath: string) => {
  const text = await Bun.file(filePath).text();
  return parseVoiceAnchors(text);
};
