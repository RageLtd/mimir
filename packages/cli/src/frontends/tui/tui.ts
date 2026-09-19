import {
  ASCIIFontRenderable,
  BoxRenderable,
  type ColorInput,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";
import type { App } from "../../core/app.ts";
import type { PermissionDecision } from "../../core/permissions/rules.ts";
import type { Line, LineKind } from "../../core/transcript/reducer.ts";
import { BACKGROUND, ERROR, FOREGROUND, resolveColor, WARN } from "./colors.ts";
import { createPermissionPanel } from "./permission-panel.ts";

const TITLE = "Mimir";
const STREAMING_ID = "streaming";

const PERMISSION_KEYS: Record<string, PermissionDecision> = {
  y: "allow",
  a: "allow-always",
  n: "deny",
};

const linePrefix = (kind: LineKind) => {
  switch (kind) {
    case "user":
      return "> ";
    case "tool":
      return "⚙ ";
    case "error":
      return "✗ ";
    case "assistant":
    case "notice":
    case "blank":
      return "";
    default:
      return "";
  }
};

/** OpenTUI frontend. Talks to the behaviour layer only through `App`. */
export const runTui = async (app: App) => {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    backgroundColor: BACKGROUND,
  });
  const theme = () => {
    const { accent, muted } = app.getState().config.config.ui;
    return { accent: resolveColor(accent), muted: resolveColor(muted) };
  };

  const shell = new BoxRenderable(renderer, {
    id: "shell",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });

  const scrollback = new ScrollBoxRenderable(renderer, {
    id: "scrollback",
    flexGrow: 1,
    flexBasis: 0,
    stickyScroll: true,
    stickyStart: "bottom",
    paddingLeft: 1,
    paddingRight: 1,
  });

  const title = new ASCIIFontRenderable(renderer, {
    id: "title",
    text: TITLE,
    font: "block",
    color: theme().accent,
  });
  scrollback.add(title);

  const permissionPanel = createPermissionPanel(renderer, theme);

  const inputFrame = new BoxRenderable(renderer, {
    id: "input-frame",
    width: "100%",
    border: true,
    borderColor: theme().muted,
    focusedBorderColor: theme().accent,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const input = new InputRenderable(renderer, {
    id: "input",
    width: "100%",
    placeholder: "Ask Mimir…",
    placeholderColor: theme().muted,
  });
  inputFrame.add(input);

  const lineColor = (kind: LineKind) => {
    switch (kind) {
      case "user":
      case "notice":
      case "blank":
        return theme().muted;
      case "assistant":
        return FOREGROUND;
      case "tool":
        return WARN;
      case "error":
        return ERROR;
      default:
        return FOREGROUND;
    }
  };

  const addText = (id: string, content: string, fg: ColorInput) => {
    const text = new TextRenderable(renderer, { id, content, fg });
    scrollback.add(text);
    return text;
  };

  // Transcript lines are append-only; render only the ones not yet drawn.
  let rendered = 0;
  app.subscribe(
    (state) => state.transcript.lines,
    (lines: Line[]) => {
      for (const line of lines.slice(rendered)) {
        addText(
          `line-${line.id}`,
          `${linePrefix(line.kind)}${line.text}`,
          lineColor(line.kind),
        );
      }
      rendered = lines.length;
    },
  );

  // The in-flight assistant block is one TextRenderable that grows, then is
  // removed once the reducer has promoted it to a permanent line.
  let streaming: TextRenderable | null = null;
  app.subscribe(
    (state) => state.transcript.streaming,
    (text) => {
      if (text === null) {
        if (streaming !== null) {
          scrollback.remove(streaming);
          streaming = null;
        }
        return;
      }
      if (streaming === null) {
        streaming = addText(STREAMING_ID, text, FOREGROUND);
        return;
      }
      streaming.content = text;
    },
  );

  app.subscribe(
    (state) => state.config.config.ui,
    () => {
      const { accent, muted } = theme();
      title.color = accent;
      inputFrame.borderColor = muted;
      inputFrame.focusedBorderColor = accent;
      input.placeholderColor = muted;
    },
  );

  // While a permission request is pending the panel takes over and the input
  // is blurred so the y/a/n answer keys don't land in it.
  const pendingRequest = () => app.getState().permissions.pending[0];
  app.subscribe(
    (state) => state.permissions.pending[0],
    (request) => {
      if (request === undefined) {
        permissionPanel.hide();
        input.focus();
        return;
      }
      input.blur();
      permissionPanel.show(request);
    },
  );

  input.on(InputRenderableEvents.ENTER, (value: string) => {
    const text = value.trim();
    if (text === "") {
      return;
    }
    input.value = "";
    app.submit(text);
  });

  // Global handlers run before the focused renderable sees the key, so a
  // handled answer key must be preventDefault'ed or it lands in the input
  // the moment the panel closes and focus returns.
  const onKey = (key: KeyEvent) => {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      key.preventDefault();
      app.quit();
      return;
    }
    const request = pendingRequest();
    if (request === undefined) {
      return;
    }
    key.preventDefault();
    const decision = PERMISSION_KEYS[key.name];
    if (decision !== undefined) {
      app.answerPermission(request.id, decision);
    }
  };
  renderer.keyInput.on("keypress", onKey);
  renderer.once("destroy", () => {
    renderer.keyInput.off("keypress", onKey);
  });

  shell.add(scrollback);
  shell.add(permissionPanel.box);
  shell.add(inputFrame);
  renderer.root.add(shell);
  input.focus();

  app.onQuit(() => {
    renderer.destroy();
    process.exit(0);
  });
  return new Promise<void>(() => {});
};
