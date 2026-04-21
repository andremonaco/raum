/**
 * Shared xterm.js configuration — single source of truth for terminal
 * appearance so every pane (and any future snapshot/headless view) renders
 * with identical options.
 */

import type { ITerminalOptions, ITheme } from "@xterm/xterm";

export interface TerminalAppearanceConfig {
  fontSize: number;
  fontFamily: string;
  scrollback: number;
  theme?: ITheme;
  screenReaderMode?: boolean;
}

/**
 * Base options that apply to every terminal instance. Font settings, theme,
 * and scrollback are spliced in per-call.
 *
 * Notes on the less-obvious options:
 * - `cursorInactiveStyle` — keeps the block cursor visible when xterm loses
 *   focus (xterm's default thins to a bar, which looks jumpy on agent panes
 *   that blur/refocus on every drag).
 * - `fontLigatures: false` — disables the (opt-in) ligatures addon path. The
 *   addon isn't loaded today; this is explicit intent for future maintainers.
 * - `macOptionIsMeta` / `macOptionClickForcesSelection` — makes Option key
 *   behave as Meta (for word-wise navigation in agent CLIs) and Option+click
 *   force-select text inside selections (xterm default swallows it).
 * - `scrollOnUserInput: false` — don't jump to the bottom when the user
 *   types while scrolled back; they're usually reading.
 * - `scrollSensitivity` / `fastScrollSensitivity` — tuned for trackpad
 *   precision (1.5 lines per tick, 5 with modifier).
 */
export const BASE_TERMINAL_OPTIONS = {
  cursorBlink: true,
  cursorStyle: "block" as const,
  cursorInactiveStyle: "block" as const,
  lineHeight: 1.1,
  letterSpacing: 0,
  fontLigatures: false,
  fontWeight: "normal" as const,
  fontWeightBold: "700" as const,
  allowProposedApi: true,
  macOptionIsMeta: true,
  macOptionClickForcesSelection: true,
  scrollOnUserInput: false,
  fastScrollSensitivity: 5,
  scrollSensitivity: 1.5,
  // Default is already false, but set explicitly: ED2 (`\x1b[2J` - erase
  // entire display) should clear the viewport WITHOUT pushing erased
  // lines into scrollback. Tmux's composite repaint uses ED2; without
  // this, every repaint would cram the previous viewport into
  // scrollback — stacking ghost frames on every resize.
  scrollOnEraseInDisplay: false,
} satisfies Partial<ITerminalOptions> & { fontLigatures: boolean };

/**
 * Build the full `ITerminalOptions` payload for a live pane.
 */
export function getXtermOptions(config: TerminalAppearanceConfig): ITerminalOptions {
  return {
    ...BASE_TERMINAL_OPTIONS,
    fontSize: config.fontSize,
    fontFamily: config.fontFamily,
    theme: config.theme,
    scrollback: config.scrollback,
    screenReaderMode: config.screenReaderMode ?? false,
    // Smooth scroll is disabled project-wide — agent panes generate enough
    // output that interpolated scrolls become disorienting.
    smoothScrollDuration: 0,
  };
}

/**
 * Build options for a read-only / snapshot view. Disables cursor blink and
 * input so the pane is safe to mount with no PTY attached.
 */
export function getXtermOptionsForSnapshot(config: TerminalAppearanceConfig): ITerminalOptions {
  return {
    ...getXtermOptions(config),
    cursorBlink: false,
    cursorStyle: "bar",
    disableStdin: true,
  };
}

/**
 * Per-cell pixel metrics for a monospace font at `fontSize`. Used to convert
 * a pixel viewport into cols/rows without measuring the DOM.
 */
export function getTerminalMetrics(fontSize: number): {
  cellWidth: number;
  cellHeight: number;
} {
  return {
    cellWidth: Math.max(6, Math.floor(fontSize * 0.6)),
    cellHeight: Math.max(10, Math.floor(fontSize * 1.1)),
  };
}

/**
 * Convert a pixel viewport into cols/rows, clamped to raum's PTY bounds
 * (`MIN/MAX_COLS`, `MIN/MAX_ROWS` in `src-tauri/src/commands/terminal.rs`).
 */
export function calculateTerminalDimensions(
  widthPx: number,
  heightPx: number,
  fontSize: number,
): { cols: number; rows: number } {
  const metrics = getTerminalMetrics(fontSize);
  return {
    cols: Math.max(20, Math.min(500, Math.floor(widthPx / metrics.cellWidth))),
    rows: Math.max(5, Math.min(200, Math.floor(heightPx / metrics.cellHeight))),
  };
}
