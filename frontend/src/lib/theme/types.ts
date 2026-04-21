/**
 * Theme types shared between the runtime, the catalog manifest, and the
 * Settings picker. Two shapes:
 *
 *  - {@link RawThemeJson} — the loose VSCode-color-theme JSON as it ships in
 *    `tm-themes` or a user-supplied `.json` file. Everything is optional;
 *    the normalizer is responsible for filling in fallbacks.
 *  - {@link RaumTheme} — the normalized internal object: a guaranteed chrome
 *    palette + xterm palette + the original `tokenColors` array (kept around
 *    so the generic CodeMirror fallback can produce a `HighlightStyle` from
 *    any theme, even ones we don't have a `@uiw/...` package for).
 */

import type { ITheme } from "@xterm/xterm";

// ---------------------------------------------------------------------------
// Raw VSCode theme JSON
// ---------------------------------------------------------------------------

export type ThemeKind = "dark" | "light";

/** A single TextMate-style scope rule from a VSCode theme's `tokenColors`. */
export interface RawTokenColor {
  name?: string;
  scope?: string | string[];
  settings?: {
    foreground?: string;
    background?: string;
    fontStyle?: string;
  };
}

export interface RawThemeJson {
  /** Theme variant. VSCode also allows `hc-dark`/`hc-light`; we collapse those to dark/light. */
  type?: ThemeKind | "hc-dark" | "hc-light" | string;
  /** UI / workbench color tokens, dot-namespaced (e.g. `editor.background`). */
  colors?: Record<string, string>;
  /** TextMate-style scope-to-style rules for syntax highlighting. */
  tokenColors?: RawTokenColor[];
  /** Newer LSP-based highlighting rules. We don't currently consume these. */
  semanticTokenColors?: Record<string, unknown>;
  /** Optional theme name; not used at runtime, kept for diagnostics. */
  name?: string;
}

// ---------------------------------------------------------------------------
// Normalized internal shape
// ---------------------------------------------------------------------------

/**
 * Semantic chrome palette. The names mirror the existing CSS-variable set in
 * `styles.css` so {@link applyChrome} can write them straight onto `:root`
 * and Tailwind's `@theme inline` block keeps semantic class names
 * (`bg-background`, `text-muted-foreground`, …) bound to the right colors
 * without a rebuild.
 *
 * Every field is a CSS color string ready to drop into a custom property.
 * Shadow + scrim fields are theme-kind-derived (not read from VSCode JSON)
 * so light themes get slate-tinted depth instead of pure black.
 */
export interface ChromePalette {
  background: string;
  foreground: string;

  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;

  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;

  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;

  destructive: string;
  border: string;
  input: string;
  ring: string;

  /** Terminal canvas background — `terminal.background` or `editor.background` fallback. */
  terminalBackground: string;
  /** Terminal canvas foreground — `terminal.foreground` or `editor.foreground` fallback. */
  terminalForeground: string;

  // ── Extended surface tokens ─────────────────────────────────────────────
  /** Slightly lifted surface for pane headers, tab strips, toolbars. */
  surfaceRaised: string;
  /** Pushed-back surface for the grid canvas, section headers. */
  surfaceSunken: string;
  /** Persistent rails (sidebar, settings nav) — a tonal step from card/popover. */
  panel: string;
  panelForeground: string;

  // ── Extended text hierarchy ─────────────────────────────────────────────
  /** Between mutedForeground and dim — for captions and secondary metadata. */
  foregroundSubtle: string;
  /** Disabled / off state text. */
  foregroundDim: string;

  // ── Extended border weights ─────────────────────────────────────────────
  /** Hairline dividers, inline separators. */
  borderSubtle: string;
  /** Selected-tab underline, active-row outline. */
  borderStrong: string;

  // ── Feedback / state (vivid solid colors; use with /15 tint for bg) ─────
  success: string;
  warning: string;
  info: string;

  // ── Interactive state backgrounds ───────────────────────────────────────
  /** Hover fill for list rows, menu items, buttons. */
  hover: string;
  /** Active selection fill. */
  active: string;
  /** Inactive selection / persistent highlight fill. */
  selected: string;

  // ── Overlay / scrim (theme-kind-derived) ────────────────────────────────
  scrim: string;
  scrimStrong: string;

  // ── Elevation shadows (full box-shadow strings, theme-kind-derived) ─────
  shadowXs: string;
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;
}

/** Xterm `ITheme` re-exported for consumers that don't want to depend on @xterm/xterm directly. */
export type XtermPalette = ITheme;

export interface RaumTheme {
  /** Stable id used in the config and the picker. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Variant — drives the `data-kb-theme` flag and `color-scheme`. */
  type: ThemeKind;
  /** Provenance string for diagnostics + the "About these themes" disclosure. */
  sourceVersion: string;
  /** Resolved CSS-var values for the workbench chrome. */
  chrome: ChromePalette;
  /** Resolved xterm.js theme. */
  xterm: XtermPalette;
  /**
   * Raw VSCode JSON colors map — kept around for advanced consumers
   * (e.g. CodeMirror generic fallback that needs unmapped tokens).
   */
  rawColors: Record<string, string>;
  /** Raw tokenColors for the CodeMirror generic-fallback path. */
  tokenColors: RawTokenColor[];
}
