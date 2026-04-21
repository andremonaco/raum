/**
 * Normalize a raw VSCode color theme JSON into a {@link RaumTheme}.
 *
 * The normalizer's job is to produce a *complete* {@link ChromePalette} +
 * {@link XtermPalette} from a (potentially sparse) VSCode theme. Real-world
 * themes omit big chunks of the workbench color set — e.g. Catppuccin Mocha
 * omits `terminal.background`, Solarized omits `sideBar.*`, GitHub Light
 * omits half the panel tokens — so every read goes through a fallback chain
 * that ends in a sensible per-`type` baseline.
 *
 * VSCode's own resolver follows roughly the same pattern; the chains here
 * mirror the documented `theme-color` reference where one exists and fall
 * back to neutrals derived from `editor.background`/`editor.foreground`
 * otherwise.
 */

import { parse as parseJsonc } from "jsonc-parser";

import type { ChromePalette, RawThemeJson, RaumTheme, ThemeKind, XtermPalette } from "./types";

// ---------------------------------------------------------------------------
// Per-`type` fallback baselines
// ---------------------------------------------------------------------------

const DARK_BASELINE: ChromePalette = {
  background: "#0b0b0d",
  foreground: "#e6e6e6",
  card: "#16161a",
  cardForeground: "#e6e6e6",
  popover: "#16161a",
  popoverForeground: "#e6e6e6",
  primary: "#e6e6e6",
  primaryForeground: "#16161a",
  secondary: "#27272a",
  secondaryForeground: "#e6e6e6",
  muted: "#27272a",
  mutedForeground: "#a1a1aa",
  accent: "#27272a",
  accentForeground: "#e6e6e6",
  destructive: "#ef4444",
  border: "#ffffff1a",
  input: "#ffffff26",
  ring: "#71717a",
  terminalBackground: "#0b0b0d",
  terminalForeground: "#e6e6e6",
  surfaceRaised: "#141418",
  surfaceSunken: "#09090b",
  panel: "#111114",
  panelForeground: "#e6e6e6",
  foregroundSubtle: "color-mix(in oklab, #e6e6e6 65%, transparent)",
  foregroundDim: "color-mix(in oklab, #e6e6e6 45%, transparent)",
  borderSubtle: "color-mix(in oklab, #e6e6e6 8%, transparent)",
  borderStrong: "color-mix(in oklab, #e6e6e6 22%, transparent)",
  success: "#22c55e",
  warning: "#eab308",
  info: "#38bdf8",
  hover: "color-mix(in oklab, #e6e6e6 6%, transparent)",
  active: "color-mix(in oklab, #e6e6e6 12%, transparent)",
  selected: "color-mix(in oklab, #e6e6e6 16%, transparent)",
  scrim: "rgb(0 0 0 / 0.55)",
  scrimStrong: "rgb(0 0 0 / 0.7)",
  shadowXs: "0 1px 2px rgb(0 0 0 / 0.5)",
  shadowSm: "0 2px 4px rgb(0 0 0 / 0.55), 0 1px 2px rgb(0 0 0 / 0.4)",
  shadowMd: "0 8px 16px -4px rgb(0 0 0 / 0.6), 0 2px 4px rgb(0 0 0 / 0.4)",
  shadowLg:
    "0 24px 64px -12px rgb(0 0 0 / 0.65), 0 0 0 1px color-mix(in oklab, #e6e6e6 8%, transparent)",
};

const LIGHT_BASELINE: ChromePalette = {
  background: "#ffffff",
  foreground: "#1f2328",
  card: "#f6f8fa",
  cardForeground: "#1f2328",
  popover: "#ffffff",
  popoverForeground: "#1f2328",
  primary: "#1f2328",
  primaryForeground: "#ffffff",
  secondary: "#eaeef2",
  secondaryForeground: "#1f2328",
  muted: "#eaeef2",
  mutedForeground: "#57606a",
  accent: "#eaeef2",
  accentForeground: "#1f2328",
  destructive: "#cf222e",
  border: "#0000001a",
  input: "#00000026",
  ring: "#0969da",
  terminalBackground: "#ffffff",
  terminalForeground: "#1f2328",
  surfaceRaised: "#f1f3f5",
  surfaceSunken: "#f6f8fa",
  panel: "#f6f8fa",
  panelForeground: "#1f2328",
  foregroundSubtle: "color-mix(in oklab, #1f2328 65%, transparent)",
  foregroundDim: "color-mix(in oklab, #1f2328 45%, transparent)",
  borderSubtle: "color-mix(in oklab, #1f2328 8%, transparent)",
  borderStrong: "color-mix(in oklab, #1f2328 22%, transparent)",
  success: "#16a34a",
  warning: "#b45309",
  info: "#0284c7",
  hover: "color-mix(in oklab, #1f2328 6%, transparent)",
  active: "color-mix(in oklab, #1f2328 12%, transparent)",
  selected: "color-mix(in oklab, #1f2328 16%, transparent)",
  scrim: "rgb(15 23 42 / 0.35)",
  scrimStrong: "rgb(15 23 42 / 0.5)",
  shadowXs: "0 1px 2px rgb(15 23 42 / 0.08)",
  shadowSm: "0 2px 4px rgb(15 23 42 / 0.10), 0 1px 2px rgb(15 23 42 / 0.06)",
  shadowMd: "0 8px 16px -4px rgb(15 23 42 / 0.14), 0 2px 4px rgb(15 23 42 / 0.08)",
  shadowLg:
    "0 24px 64px -12px rgb(15 23 42 / 0.20), 0 0 0 1px color-mix(in oklab, #1f2328 8%, transparent)",
};

/** Standard ANSI-16 dark palette, modeled on VSCode's Dark+ defaults. */
const DARK_ANSI: Required<
  Pick<
    XtermPalette,
    | "black"
    | "red"
    | "green"
    | "yellow"
    | "blue"
    | "magenta"
    | "cyan"
    | "white"
    | "brightBlack"
    | "brightRed"
    | "brightGreen"
    | "brightYellow"
    | "brightBlue"
    | "brightMagenta"
    | "brightCyan"
    | "brightWhite"
  >
> = {
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

/** Standard ANSI-16 light palette, modeled on VSCode's Light+ defaults. */
const LIGHT_ANSI: typeof DARK_ANSI = {
  black: "#000000",
  red: "#cd3131",
  green: "#00bc00",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#686868",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

// ---------------------------------------------------------------------------
// Resolver helpers
// ---------------------------------------------------------------------------

/** First defined value in `keys`, falling back to `fallback`. */
function pick(colors: Record<string, string>, keys: readonly string[], fallback: string): string {
  for (const k of keys) {
    const v = colors[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return fallback;
}

/** Coerce VSCode `hc-dark`/`hc-light` to the closest dark/light variant. */
function coerceType(raw: string | undefined): ThemeKind {
  if (!raw) return "dark";
  const v = raw.toLowerCase();
  if (v === "light" || v === "hc-light" || v === "hcLight".toLowerCase()) return "light";
  return "dark";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a raw string (JSON or JSONC) into {@link RawThemeJson}. Used by the
 * BYO-theme path where the user picks any `.json` file off disk. Curated
 * catalog files are already plain JSON and can be `import()`-ed directly.
 */
export function parseRawTheme(raw: string): RawThemeJson {
  const errors: unknown[] = [];
  const value = parseJsonc(raw, errors as never[], { allowTrailingComma: true });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Theme JSON must be an object with `colors` / `tokenColors`.");
  }
  return value as RawThemeJson;
}

/** Resolve a sparse VSCode theme JSON into a fully-populated {@link RaumTheme}. */
export function normalizeTheme(
  raw: RawThemeJson,
  meta: { id: string; label: string; sourceVersion: string },
): RaumTheme {
  const type = coerceType(raw.type);
  const baseline = type === "light" ? LIGHT_BASELINE : DARK_BASELINE;
  const ansi = type === "light" ? LIGHT_ANSI : DARK_ANSI;
  const colors = raw.colors ?? {};

  const editorBg = pick(colors, ["editor.background"], baseline.background);
  const editorFg = pick(colors, ["editor.foreground", "foreground"], baseline.foreground);

  const chrome: ChromePalette = {
    background: editorBg,
    foreground: editorFg,
    card: pick(
      colors,
      ["sideBar.background", "panel.background", "editorWidget.background"],
      baseline.card,
    ),
    cardForeground: pick(colors, ["sideBar.foreground", "foreground"], editorFg),
    popover: pick(
      colors,
      ["editorHoverWidget.background", "menu.background", "dropdown.background"],
      baseline.popover,
    ),
    popoverForeground: pick(
      colors,
      ["editorHoverWidget.foreground", "menu.foreground", "dropdown.foreground"],
      editorFg,
    ),
    primary: pick(colors, ["button.background", "activityBarBadge.background"], baseline.primary),
    primaryForeground: pick(
      colors,
      ["button.foreground", "activityBarBadge.foreground"],
      baseline.primaryForeground,
    ),
    secondary: pick(
      colors,
      ["button.secondaryBackground", "activityBar.background", "titleBar.activeBackground"],
      baseline.secondary,
    ),
    secondaryForeground: pick(
      colors,
      ["button.secondaryForeground", "activityBar.foreground"],
      editorFg,
    ),
    muted: pick(
      colors,
      ["editorWidget.background", "tab.inactiveBackground", "list.inactiveSelectionBackground"],
      baseline.muted,
    ),
    mutedForeground: pick(
      colors,
      ["descriptionForeground", "disabledForeground", "tab.inactiveForeground"],
      baseline.mutedForeground,
    ),
    accent: pick(
      colors,
      ["list.hoverBackground", "list.activeSelectionBackground"],
      baseline.accent,
    ),
    accentForeground: pick(
      colors,
      ["list.activeSelectionForeground", "list.hoverForeground"],
      editorFg,
    ),
    destructive: pick(
      colors,
      ["errorForeground", "editorError.foreground", "notificationsErrorIcon.foreground"],
      baseline.destructive,
    ),
    border: pick(
      colors,
      ["panel.border", "sideBar.border", "tab.border", "contrastBorder"],
      baseline.border,
    ),
    input: pick(colors, ["input.background", "editorWidget.background"], baseline.input),
    ring: pick(
      colors,
      ["focusBorder", "inputOption.activeBorder", "editorCursor.foreground"],
      baseline.ring,
    ),
    terminalBackground: pick(colors, ["terminal.background", "editor.background"], editorBg),
    terminalForeground: pick(colors, ["terminal.foreground", "editor.foreground"], editorFg),

    // Surface tokens
    surfaceRaised: pick(
      colors,
      ["titleBar.activeBackground", "editorGroupHeader.tabsBackground", "tab.inactiveBackground"],
      baseline.surfaceRaised,
    ),
    surfaceSunken: pick(
      colors,
      ["sideBarSectionHeader.background", "panel.background", "activityBar.background"],
      baseline.surfaceSunken,
    ),
    panel: pick(
      colors,
      ["sideBar.background", "panel.background", "activityBar.background"],
      baseline.panel,
    ),
    panelForeground: pick(colors, ["sideBar.foreground", "panelTitle.activeForeground"], editorFg),

    // Text hierarchy
    foregroundSubtle: pick(
      colors,
      ["descriptionForeground", "foreground"],
      baseline.foregroundSubtle,
    ),
    foregroundDim: pick(
      colors,
      ["disabledForeground", "tab.inactiveForeground"],
      baseline.foregroundDim,
    ),

    // Border weights
    borderSubtle: pick(
      colors,
      ["widget.border", "editorWidget.border", "input.border"],
      baseline.borderSubtle,
    ),
    borderStrong: pick(
      colors,
      ["focusBorder", "contrastActiveBorder", "tab.activeBorder"],
      baseline.borderStrong,
    ),

    // Feedback / state
    success: pick(
      colors,
      ["terminal.ansiGreen", "gitDecoration.addedResourceForeground", "charts.green"],
      baseline.success,
    ),
    warning: pick(
      colors,
      [
        "editorWarning.foreground",
        "list.warningForeground",
        "terminal.ansiYellow",
        "charts.yellow",
      ],
      baseline.warning,
    ),
    info: pick(
      colors,
      ["editorInfo.foreground", "terminal.ansiBlue", "charts.blue"],
      baseline.info,
    ),

    // Interactive states
    hover: pick(colors, ["list.hoverBackground", "toolbar.hoverBackground"], baseline.hover),
    active: pick(
      colors,
      ["list.activeSelectionBackground", "list.focusBackground"],
      baseline.active,
    ),
    selected: pick(
      colors,
      ["list.inactiveSelectionBackground", "editor.selectionBackground"],
      baseline.selected,
    ),

    // Theme-kind-derived: scrims and shadows
    scrim: baseline.scrim,
    scrimStrong: baseline.scrimStrong,
    shadowXs: baseline.shadowXs,
    shadowSm: baseline.shadowSm,
    shadowMd: baseline.shadowMd,
    shadowLg: baseline.shadowLg,
  };

  const xterm: XtermPalette = {
    background: chrome.terminalBackground,
    foreground: chrome.terminalForeground,
    cursor: pick(
      colors,
      ["terminalCursor.foreground", "editorCursor.foreground"],
      chrome.terminalForeground,
    ),
    cursorAccent: pick(colors, ["terminalCursor.background"], chrome.terminalBackground),
    selectionBackground: pick(
      colors,
      ["terminal.selectionBackground", "editor.selectionBackground"],
      chrome.muted,
    ),
    selectionForeground: colors["terminal.selectionForeground"],
    selectionInactiveBackground: colors["terminal.inactiveSelectionBackground"],
    black: pick(colors, ["terminal.ansiBlack"], ansi.black),
    red: pick(colors, ["terminal.ansiRed"], ansi.red),
    green: pick(colors, ["terminal.ansiGreen"], ansi.green),
    yellow: pick(colors, ["terminal.ansiYellow"], ansi.yellow),
    blue: pick(colors, ["terminal.ansiBlue"], ansi.blue),
    magenta: pick(colors, ["terminal.ansiMagenta"], ansi.magenta),
    cyan: pick(colors, ["terminal.ansiCyan"], ansi.cyan),
    white: pick(colors, ["terminal.ansiWhite"], ansi.white),
    brightBlack: pick(colors, ["terminal.ansiBrightBlack"], ansi.brightBlack),
    brightRed: pick(colors, ["terminal.ansiBrightRed"], ansi.brightRed),
    brightGreen: pick(colors, ["terminal.ansiBrightGreen"], ansi.brightGreen),
    brightYellow: pick(colors, ["terminal.ansiBrightYellow"], ansi.brightYellow),
    brightBlue: pick(colors, ["terminal.ansiBrightBlue"], ansi.brightBlue),
    brightMagenta: pick(colors, ["terminal.ansiBrightMagenta"], ansi.brightMagenta),
    brightCyan: pick(colors, ["terminal.ansiBrightCyan"], ansi.brightCyan),
    brightWhite: pick(colors, ["terminal.ansiBrightWhite"], ansi.brightWhite),
  };

  return {
    id: meta.id,
    label: meta.label,
    type,
    sourceVersion: meta.sourceVersion,
    chrome,
    xterm,
    rawColors: colors,
    tokenColors: raw.tokenColors ?? [],
  };
}
