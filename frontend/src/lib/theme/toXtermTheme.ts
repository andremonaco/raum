/**
 * Tiny re-exports + helpers for the xterm side of the theme runtime.
 *
 * The actual VSCode→xterm mapping happens inside {@link normalizeTheme} so
 * the same fallback chain runs once, eagerly, instead of being duplicated
 * across every consumer. This file just hands back the resolved palette
 * (and a no-op fallback for early boot before any theme has loaded).
 */

import type { RaumTheme, XtermPalette } from "./types";

/** Last-resort xterm theme used if the controller is queried before any
 *  theme has resolved (e.g. unit tests, very early `onMount`). Tracks the
 *  default-dark `terminal.background` so the brief pre-resolve window
 *  doesn't flash a darker tone than the resolved theme. */
export const FALLBACK_XTERM_THEME: XtermPalette = {
  background: "#141418",
  foreground: "#e6e6e6",
};

export function getXtermTheme(theme: RaumTheme | null): XtermPalette {
  return theme?.xterm ?? FALLBACK_XTERM_THEME;
}
