import {
  BoxRenderable,
  type CliRenderer,
  type ColorInput,
  TextRenderable,
} from "@opentui/core";
import {
  eligibleForAlways,
  type PermissionRequest,
  summarize,
} from "../../core/permissions/rules.ts";
import { FOREGROUND, WARN } from "./colors.ts";

const OPTIONS_FULL = "[y] Allow   [a] Allow always   [n] Deny";
const OPTIONS_NO_ALWAYS = "[y] Allow   [n] Deny";
const COMPOUND_NOTE = "allow-always unavailable: compound shell command";

export type PanelTheme = { accent: ColorInput; muted: ColorInput };

/**
 * The permission prompt shown above the input while a request is pending.
 * Pure display: the key handling lives in the TUI's global key listener.
 */
export const createPermissionPanel = (
  renderer: CliRenderer,
  theme: () => PanelTheme,
) => {
  const box = new BoxRenderable(renderer, {
    id: "permission-panel",
    width: "100%",
    border: true,
    borderColor: WARN,
    paddingLeft: 1,
    paddingRight: 1,
    flexDirection: "column",
    visible: false,
  });
  let lineId = 0;

  const clear = () => {
    for (const child of box.getChildren()) {
      box.remove(child);
    }
  };

  const line = (content: string, fg: ColorInput) => {
    lineId += 1;
    box.add(
      new TextRenderable(renderer, {
        id: `permission-line-${lineId}`,
        content,
        fg,
      }),
    );
  };

  const show = (request: PermissionRequest) => {
    clear();
    line(`Permission: ${request.toolName}`, WARN);
    line(summarize(request), FOREGROUND);
    if (request.reasoning !== undefined) {
      line(`why: ${request.reasoning}`, theme().muted);
    }
    if (request.decisionReason !== undefined) {
      line(request.decisionReason, theme().muted);
    }
    const always = eligibleForAlways(request);
    line(always ? OPTIONS_FULL : OPTIONS_NO_ALWAYS, theme().accent);
    if (!always) {
      line(COMPOUND_NOTE, theme().muted);
    }
    box.visible = true;
  };

  const hide = () => {
    box.visible = false;
    clear();
  };

  return { box, show, hide };
};
