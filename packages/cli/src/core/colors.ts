/**
 * Colour strings as they appear in config. Dependency-free so the schema and
 * the io worker can validate them without loading the TUI runtime:
 *   `default`  — the terminal's foreground
 *   `ansi:N`   — the terminal's own palette slot (0–15 are the named colours)
 *   `#rrggbb`  — a fixed colour that ignores the terminal theme
 */
export const ANSI_PREFIX = "ansi:";
export const DEFAULT_COLOR = "default";
export const COLOR_PATTERN =
  /^(default|ansi:\d{1,3}|#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?)$/;
export const COLOR_HINT = "expected default, ansi:N or #rrggbb";

export const isColor = (value: string) => COLOR_PATTERN.test(value);

// ANSI slots: 4 blue, 8 bright black.
export const DEFAULT_ACCENT = `${ANSI_PREFIX}4`;
export const DEFAULT_MUTED = `${ANSI_PREFIX}8`;
