/**
 * Write a {@link ChromePalette} to the document root as CSS custom properties.
 *
 * Pure DOM write, no IPC, no debouncing. Keeps the snappy "first frame is
 * correct" pattern:
 * the first paint reads the static `:root` defaults from `styles.css`; once
 * the chosen theme JSON has been parsed (a handful of ms after boot), this
 * overwrites those vars and Tailwind's `@theme inline` block re-resolves
 * every semantic class (`bg-background`, `border-border`, …) automatically.
 *
 * The corresponding `data-kb-theme` attribute toggles the existing
 * `@custom-variant dark` directive in `styles.css:4`, so any future
 * dark-mode overrides written under `dark:` Tailwind variants light up
 * for free.
 */

import type { ChromePalette, ThemeKind } from "./types";

/** Map a `ChromePalette` field name to its CSS variable name. */
const VAR_NAMES: Record<keyof ChromePalette, string> = {
  background: "--background",
  foreground: "--foreground",
  card: "--card",
  cardForeground: "--card-foreground",
  popover: "--popover",
  popoverForeground: "--popover-foreground",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  secondary: "--secondary",
  secondaryForeground: "--secondary-foreground",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  accent: "--accent",
  accentForeground: "--accent-foreground",
  destructive: "--destructive",
  border: "--border",
  input: "--input",
  ring: "--ring",
  terminalBackground: "--terminal-bg",
  terminalForeground: "--terminal-fg",
  surfaceRaised: "--surface-raised",
  surfaceSunken: "--surface-sunken",
  panel: "--panel",
  panelForeground: "--panel-foreground",
  foregroundSubtle: "--foreground-subtle",
  foregroundDim: "--foreground-dim",
  borderSubtle: "--border-subtle",
  borderStrong: "--border-strong",
  success: "--success",
  warning: "--warning",
  info: "--info",
  hover: "--hover",
  active: "--active",
  selected: "--selected",
  scrim: "--scrim",
  scrimStrong: "--scrim-strong",
  shadowXs: "--shadow-xs",
  shadowSm: "--shadow-sm",
  shadowMd: "--shadow-md",
  shadowLg: "--shadow-lg",
};

/**
 * Apply a chrome palette to the DOM. Pass `root` for tests; defaults to
 * `document.documentElement` in the browser. Also flips `data-kb-theme` and
 * `color-scheme` so the right native form controls + Tailwind `dark:` variants
 * light up.
 */
export function applyChrome(
  palette: ChromePalette,
  type: ThemeKind,
  root: HTMLElement = document.documentElement,
): void {
  for (const key of Object.keys(VAR_NAMES) as Array<keyof ChromePalette>) {
    root.style.setProperty(VAR_NAMES[key], palette[key]);
  }
  root.setAttribute("data-kb-theme", type);
  root.style.setProperty("color-scheme", type);
}
