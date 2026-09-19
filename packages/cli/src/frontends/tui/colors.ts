import { RGBA } from "@opentui/core";
import { ANSI_PREFIX, DEFAULT_COLOR } from "../../core/colors.ts";

/** Turns a config colour string into an OpenTUI colour with palette intent. */
export const resolveColor = (value: string) => {
  if (value === DEFAULT_COLOR) {
    return RGBA.defaultForeground();
  }
  if (value.startsWith(ANSI_PREFIX)) {
    return RGBA.fromIndex(Number(value.slice(ANSI_PREFIX.length)));
  }
  return value;
};

// ANSI slots: 1 red, 3 yellow.
export const FOREGROUND = RGBA.defaultForeground();
export const BACKGROUND = RGBA.defaultBackground();
export const ERROR = RGBA.fromIndex(1);
export const WARN = RGBA.fromIndex(3);
