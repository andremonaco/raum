/**
 * Resolve the CodeMirror v6 theme `Extension` for a given {@link RaumTheme}.
 *
 * Two paths:
 *
 *  1. **Pinned** — for curated themes that ship a polished `@uiw/codemirror-theme-<name>`
 *     (or `@codemirror/theme-one-dark`) implementation, lazy-import that package and
 *     return its `Extension`. Bundle cost: each themed package becomes its own async
 *     chunk that's only fetched when the user opens the file editor *and* has that
 *     theme selected.
 *
 *  2. **Generic** — for BYO themes (and curated themes without a `@uiw/...` counterpart,
 *     e.g. Catppuccin / Rose Pine), build a CodeMirror theme on the fly with
 *     `@uiw/codemirror-themes`' `createTheme()`. The chrome side is trivial; the
 *     scope→tag conversion is the lossy bit, handled by {@link tokenColorsToStyles}.
 *
 * The output is always a single `Extension` ready to drop into an `EditorState`
 * extensions array (alongside `basicSetup`, `keymap.of(...)`, the language extension,
 * etc.).
 */

import type { Extension } from "@codemirror/state";
import { createTheme } from "@uiw/codemirror-themes";
import { tags as t, type Tag } from "@lezer/highlight";

import type { RaumTheme, RawTokenColor } from "./types";

/**
 * One row of the scope → Lezer tag mapping table. The mapper picks the
 * **longest matching prefix**, so more specific entries (e.g.
 * `keyword.control`) take precedence over general ones (`keyword`).
 */
interface ScopeMapping {
  scope: string;
  tag: Tag | readonly Tag[];
}

const SCOPE_TABLE: readonly ScopeMapping[] = [
  // Comments
  { scope: "comment", tag: t.comment },
  { scope: "punctuation.definition.comment", tag: t.comment },

  // Strings
  { scope: "string.regexp", tag: t.regexp },
  { scope: "string.quoted", tag: t.string },
  { scope: "string", tag: t.string },

  // Numbers / atoms
  { scope: "constant.numeric", tag: t.number },
  { scope: "constant.language", tag: t.atom },
  { scope: "constant.character", tag: t.character },
  { scope: "constant", tag: t.literal },

  // Keywords / control flow
  { scope: "keyword.control", tag: t.controlKeyword },
  { scope: "keyword.operator", tag: t.operator },
  { scope: "keyword", tag: t.keyword },
  { scope: "storage.modifier", tag: t.modifier },
  { scope: "storage.type", tag: t.keyword },
  { scope: "storage", tag: t.keyword },

  // Functions / classes / types
  { scope: "entity.name.function", tag: t.function(t.variableName) },
  { scope: "support.function", tag: t.function(t.variableName) },
  { scope: "entity.name.class", tag: t.className },
  { scope: "entity.name.type", tag: t.typeName },
  { scope: "support.class", tag: t.className },
  { scope: "support.type", tag: t.typeName },

  // Markup (HTML / XML / JSX)
  { scope: "entity.name.tag", tag: t.tagName },
  { scope: "entity.other.attribute-name", tag: t.attributeName },

  // Variables
  { scope: "variable.parameter", tag: t.local(t.variableName) },
  { scope: "variable.other", tag: t.variableName },
  { scope: "variable", tag: t.variableName },

  // Properties
  { scope: "meta.property-name", tag: t.propertyName },
  { scope: "support.type.property-name", tag: t.propertyName },

  // Markdown
  { scope: "markup.heading", tag: t.heading },
  { scope: "markup.bold", tag: t.strong },
  { scope: "markup.italic", tag: t.emphasis },
  { scope: "markup.underline.link", tag: t.link },

  // Errors
  { scope: "invalid", tag: t.invalid },
];

interface FontStyleAttrs {
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
}

function parseFontStyle(raw: string | undefined): FontStyleAttrs {
  if (!raw) return {};
  const parts = raw.split(/\s+/).filter(Boolean);
  const out: FontStyleAttrs = {};
  if (parts.includes("bold")) out.fontWeight = "bold";
  if (parts.includes("italic")) out.fontStyle = "italic";
  if (parts.includes("underline")) out.textDecoration = "underline";
  if (parts.includes("strikethrough")) {
    out.textDecoration = out.textDecoration ? `${out.textDecoration} line-through` : "line-through";
  }
  return out;
}

/**
 * Resolve a single scope string (already trimmed) to a Lezer tag using
 * longest-prefix wins. Returns null when the scope doesn't match any entry —
 * unknown scopes are silently dropped from the resulting `HighlightStyle`.
 */
function scopeToTag(scope: string): Tag | readonly Tag[] | null {
  let best: ScopeMapping | null = null;
  for (const row of SCOPE_TABLE) {
    if (scope === row.scope || scope.startsWith(`${row.scope}.`)) {
      if (!best || row.scope.length > best.scope.length) best = row;
    }
  }
  return best?.tag ?? null;
}

/**
 * Convert a VSCode theme's `tokenColors` array into the `styles` shape
 * `createTheme()` expects. Lossy by design — see file header.
 */
export function tokenColorsToStyles(
  tokenColors: readonly RawTokenColor[],
): Array<{ tag: Tag | readonly Tag[]; color?: string } & FontStyleAttrs> {
  const out: Array<{ tag: Tag | readonly Tag[]; color?: string } & FontStyleAttrs> = [];
  for (const rule of tokenColors) {
    const settings = rule.settings;
    if (!settings) continue;
    const fg = settings.foreground;
    const fontAttrs = parseFontStyle(settings.fontStyle);
    if (!fg && Object.keys(fontAttrs).length === 0) continue;
    const scopes = Array.isArray(rule.scope)
      ? rule.scope
      : typeof rule.scope === "string"
        ? rule.scope.split(",").map((s) => s.trim())
        : [];
    for (const raw of scopes) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const tag = scopeToTag(trimmed);
      if (!tag) continue;
      out.push({
        tag,
        ...(fg ? { color: fg } : {}),
        ...fontAttrs,
      });
    }
  }
  return out;
}

/**
 * Build a `createTheme` extension from a {@link RaumTheme} using only the
 * normalized chrome + raw `tokenColors`. Used as the BYO fallback and for
 * curated themes that don't have a hand-tuned `@uiw/...` package.
 */
export function buildGenericCodeMirrorTheme(raum: RaumTheme): Extension {
  return createTheme({
    theme: raum.type,
    settings: {
      background: raum.chrome.terminalBackground,
      foreground: raum.chrome.foreground,
      caret: raum.xterm.cursor ?? raum.chrome.foreground,
      selection: raum.chrome.muted,
      selectionMatch: raum.chrome.muted,
      lineHighlight: raum.chrome.card,
      gutterBackground: raum.chrome.terminalBackground,
      gutterForeground: raum.chrome.mutedForeground,
      gutterActiveForeground: raum.chrome.foreground,
      gutterBorder: raum.chrome.border,
    },
    styles: tokenColorsToStyles(raum.tokenColors),
  });
}

// ---------------------------------------------------------------------------
// Pinned theme loaders
// ---------------------------------------------------------------------------

type PinnedLoader = () => Promise<Extension>;

/**
 * Curated id → lazy loader for a hand-tuned `@uiw/...` (or @codemirror/...)
 * theme. Themes not listed here fall through to {@link buildGenericCodeMirrorTheme}.
 */
const PINNED: Record<string, PinnedLoader> = {
  "raum-default-dark": () => import("@codemirror/theme-one-dark").then((m) => m.oneDark),
  "one-dark-pro": () => import("@codemirror/theme-one-dark").then((m) => m.oneDark),
  dracula: () => import("@uiw/codemirror-theme-dracula").then((m) => m.dracula),
  "tokyo-night": () => import("@uiw/codemirror-theme-tokyo-night").then((m) => m.tokyoNight),
  nord: () => import("@uiw/codemirror-theme-nord").then((m) => m.nord),
  "github-dark": () => import("@uiw/codemirror-theme-github").then((m) => m.githubDark),
  "github-light": () => import("@uiw/codemirror-theme-github").then((m) => m.githubLight),
  "solarized-dark": () => import("@uiw/codemirror-theme-solarized").then((m) => m.solarizedDark),
  "solarized-light": () => import("@uiw/codemirror-theme-solarized").then((m) => m.solarizedLight),
  monokai: () => import("@uiw/codemirror-theme-monokai").then((m) => m.monokai),
};

/** Whether a curated theme has a pinned high-quality CodeMirror counterpart. */
export function hasPinnedCodeMirrorTheme(themeId: string): boolean {
  return Object.hasOwn(PINNED, themeId);
}

/**
 * Resolve a CodeMirror v6 theme `Extension` for the given Raum theme. Tries
 * the pinned loader first; falls back to the generic builder for BYO themes
 * and any curated theme without a `@uiw/...` package.
 */
export async function loadCodeMirrorTheme(theme: RaumTheme): Promise<Extension> {
  const pinned = PINNED[theme.id];
  if (pinned) {
    try {
      return await pinned();
    } catch (e) {
      console.warn(
        `[theme] pinned CodeMirror theme failed to load for "${theme.id}", using generic fallback`,
        e,
      );
    }
  }
  return buildGenericCodeMirrorTheme(theme);
}
