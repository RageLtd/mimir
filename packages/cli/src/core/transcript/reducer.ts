import { loadedCount } from "../resources/loader.ts";
import type { Action } from "../store/actions.ts";
import type { AppStore } from "../store/state.ts";

export type LineKind =
  | "user"
  | "assistant"
  | "tool"
  | "error"
  | "notice"
  | "blank";

/** `text` is raw content; prefixes and glyphs are the frontend's business. */
export type Line = { id: number; kind: LineKind; text: string };

export type TranscriptState = {
  lines: Line[];
  /** Text of the assistant block currently streaming, or null between blocks. */
  streaming: string | null;
  nextId: number;
};

export const INITIAL_TRANSCRIPT: TranscriptState = {
  lines: [],
  streaming: null,
  nextId: 1,
};

const UNTOUCHED = "using defaults, file left untouched";

const withLine = (state: TranscriptState, kind: LineKind, text: string) => ({
  ...state,
  lines: [...state.lines, { id: state.nextId, kind, text }],
  nextId: state.nextId + 1,
});

export const transcriptReducer = (state: TranscriptState, action: Action) => {
  switch (action.type) {
    case "input/submit":
      return withLine(state, "user", action.text);
    case "notice":
      return withLine(state, "notice", action.text);
    case "agent/text-delta":
      return { ...state, streaming: (state.streaming ?? "") + action.text };
    case "agent/block-end":
      return state.streaming === null
        ? state
        : { ...withLine(state, "assistant", state.streaming), streaming: null };
    case "agent/tool-use":
      return withLine(state, "tool", action.name);
    case "agent/turn-end":
      return withLine(state, "blank", "");
    case "agent/error":
      return withLine(state, "error", action.message);
    case "worker/error":
      return withLine(state, "error", `${action.worker}: ${action.message}`);
    case "config/load-failed":
      return withLine(state, "error", `config: ${action.error} — ${UNTOUCHED}`);
    case "config/save-failed":
      return withLine(state, "error", `config save: ${action.error}`);
    case "permissions/load-failed":
      return withLine(
        state,
        "error",
        `permissions: ${action.error} — ${UNTOUCHED}`,
      );
    case "permissions/save-failed":
      return withLine(state, "error", `permissions save: ${action.error}`);
    case "resources/loaded": {
      const problems = action.reports.flatMap((report) =>
        report.errors.map((error) => `${report.path}: ${error}`),
      );
      const summary = `mcp: ${Object.keys(action.mcpServers).length} server(s) from ${loadedCount(action.reports)} file(s); plugins: ${action.plugins.length}`;
      return problems.reduce(
        (next, problem) => withLine(next, "error", problem),
        withLine(state, "notice", summary),
      );
    }
    default:
      return state;
  }
};

export const registerTranscriptSlice = (store: AppStore) => {
  store.register("transcript", INITIAL_TRANSCRIPT, transcriptReducer);
};
