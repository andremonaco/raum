/**
 * Theme orchestration. The frontend's single entry point for switching the
 * VSCode-derived appearance: loads the chosen theme JSON (curated catalog
 * lazy-import or a user-supplied `.json` on disk), normalizes it, applies
 * the chrome CSS vars, persists the choice to the backend `AppearanceConfig`,
 * and notifies subscribers (terminals, the file editor) so they can pick up
 * the new xterm/CodeMirror palettes without remounting.
 *
 * Applies immediately in the DOM, persists with a short debounce, and loads
 * from config on boot so appearance changes feel snappy without thrashing
 * the config store.
 */

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { applyChrome } from "./applyChrome";
import { normalizeTheme, parseRawTheme } from "./normalize";
import { THEME_CATALOG, DEFAULT_THEME_ID, type ThemeCatalogEntry } from "../../themes/catalog";
import type { RaumTheme, RawThemeJson, XtermPalette } from "./types";

// ---------------------------------------------------------------------------
// Persisted shape — mirrors `AppearanceConfig` in `crates/raum-core/src/config.rs`.
// ---------------------------------------------------------------------------

interface AppearanceSnapshot {
  appearance?: {
    theme_id?: string;
    custom_theme_path?: string | null;
  };
}

const PERSIST_DEBOUNCE_MS = 200;

// ---------------------------------------------------------------------------
// Module-local state
// ---------------------------------------------------------------------------

let current: RaumTheme | null = null;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
const subscribers = new Set<(theme: RaumTheme) => void>();

/**
 * Live-preview state. When the Settings theme picker is open, it calls
 * {@link beginThemePreview} to snapshot the active theme, then
 * {@link previewThemeId} on each hover to retint the chrome without
 * persisting. On close the picker calls {@link endThemePreview} with
 * `commit=true` (user clicked) or `commit=false` (user dismissed) to either
 * persist the preview or restore the snapshot.
 */
let previewOriginal: RaumTheme | null = null;
/**
 * Monotonic counter used to drop stale preview loads. On fast hover A→B→A
 * the B-load's promise can still resolve after the A-load completes; we
 * compare the captured seq to the current one before broadcasting so the
 * chrome only reflects the user's latest intent.
 */
let previewSeq = 0;

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

export function getCurrentTheme(): RaumTheme | null {
  return current;
}

export function getCurrentXtermTheme(): XtermPalette | null {
  return current?.xterm ?? null;
}

/**
 * Subscribe to theme changes. The callback fires once per successful
 * {@link loadAndApplyTheme} (after chrome has been applied). Returns an
 * unsubscribe function.
 */
export function subscribeThemeChange(cb: (theme: RaumTheme) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

export { THEME_CATALOG, DEFAULT_THEME_ID, type ThemeCatalogEntry };

export function findCatalogEntry(themeId: string): ThemeCatalogEntry | null {
  return THEME_CATALOG.find((e) => e.id === themeId) ?? null;
}

// ---------------------------------------------------------------------------
// Core load + apply
// ---------------------------------------------------------------------------

async function loadCuratedTheme(entry: ThemeCatalogEntry): Promise<RaumTheme> {
  const raw = await entry.load();
  return normalizeTheme(raw, {
    id: entry.id,
    label: entry.label,
    sourceVersion: entry.sourceVersion,
  });
}

async function loadCustomTheme(path: string): Promise<RaumTheme> {
  const text = await invoke<string>("file_read", { path });
  const raw: RawThemeJson = parseRawTheme(text);
  // The custom theme keeps its filesystem path as id so the picker can show
  // it as "Custom: …/foo.json" and so the boot flow re-resolves it from the
  // same place every launch.
  const filename = path.split(/[\\/]/).pop() ?? path;
  return normalizeTheme(raw, {
    id: `custom:${path}`,
    label: filename.replace(/\.json$/i, ""),
    sourceVersion: `custom:${path}`,
  });
}

function broadcast(theme: RaumTheme): void {
  current = theme;
  applyChrome(theme.chrome, theme.type);
  for (const cb of subscribers) {
    try {
      cb(theme);
    } catch (e) {
      console.warn("[theme] subscriber threw", e);
    }
  }
}

/**
 * Load a curated catalog theme by id and apply it. On failure (missing entry
 * or import error) falls back to the default theme so the UI never gets
 * stuck on a broken selection.
 */
export async function loadAndApplyTheme(themeId: string): Promise<RaumTheme> {
  const entry = findCatalogEntry(themeId);
  const target = entry ?? findCatalogEntry(DEFAULT_THEME_ID);
  if (!target) {
    throw new Error(`Theme catalog is empty (looking for "${themeId}")`);
  }
  try {
    const theme = await loadCuratedTheme(target);
    broadcast(theme);
    return theme;
  } catch (e) {
    console.warn(`[theme] failed to load "${target.id}"`, e);
    if (target.id !== DEFAULT_THEME_ID) {
      return loadAndApplyTheme(DEFAULT_THEME_ID);
    }
    throw e;
  }
}

/**
 * Load a user-supplied VSCode theme JSON from disk and apply it. Returns the
 * normalized theme so the caller (Settings UI) can show the resolved label.
 */
export async function loadAndApplyCustomTheme(path: string): Promise<RaumTheme> {
  const theme = await loadCustomTheme(path);
  broadcast(theme);
  return theme;
}

/** Open a file dialog for the user to pick a `.json` VSCode theme. */
export async function pickCustomThemeFile(): Promise<string | null> {
  const result = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "VSCode theme", extensions: ["json", "jsonc"] }],
    title: "Select a VSCode color theme",
  });
  return typeof result === "string" ? result : null;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface PersistArgs {
  themeId: string | null;
  customThemePath: string | null;
}

function schedulePersist(args: PersistArgs): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    invoke("config_set_appearance_theme", {
      themeId: args.themeId,
      customThemePath: args.customThemePath,
    }).catch((e) => {
      console.warn("config_set_appearance_theme failed", e);
    });
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Switch to a curated catalog theme: applies it immediately and persists the
 * choice (debounced). Clears any custom-theme-path override and subsumes any
 * in-flight preview session (so an explicit set always wins over a hover).
 */
export async function setThemeId(themeId: string): Promise<RaumTheme> {
  previewOriginal = null;
  previewSeq++;
  const theme = await loadAndApplyTheme(themeId);
  schedulePersist({ themeId, customThemePath: null });
  return theme;
}

/**
 * Switch to a custom theme: applies it immediately and persists the path
 * (debounced). The next launch will re-read the same file via the boot flow.
 */
export async function setCustomThemePath(path: string): Promise<RaumTheme> {
  previewOriginal = null;
  previewSeq++;
  const theme = await loadAndApplyCustomTheme(path);
  schedulePersist({ themeId: null, customThemePath: path });
  return theme;
}

// ---------------------------------------------------------------------------
// Live preview (hover-to-retint in the Settings picker)
// ---------------------------------------------------------------------------

/**
 * Begin a preview session: remember the currently-applied theme so we can
 * restore it if the preview is cancelled. Calling this while a session is
 * already open is a no-op — the original stays the original.
 */
export function beginThemePreview(): void {
  if (previewOriginal) return;
  previewOriginal = current;
}

/**
 * Preview a theme without persisting. The chrome, xterm palette, and every
 * subscriber retint immediately; `setThemeId` / `setCustomThemePath` are NOT
 * called, so the TOML config is untouched. No-op unless
 * {@link beginThemePreview} has been called first.
 *
 * Fast hover A→B→A can race: we tag each load with a monotonic seq and drop
 * stale results so the chrome only reflects the user's latest intent.
 */
export async function previewThemeId(themeId: string): Promise<void> {
  if (!previewOriginal) return;
  if (current?.id === themeId) return;
  const entry = findCatalogEntry(themeId);
  if (!entry) return;
  const seq = ++previewSeq;
  try {
    const theme = await loadCuratedTheme(entry);
    // Ignore if the user moved on to another hover, or the session ended.
    if (seq !== previewSeq || !previewOriginal) return;
    broadcast(theme);
  } catch (e) {
    console.warn(`[theme] preview "${themeId}" failed`, e);
  }
}

/**
 * End the preview session.
 *  - `commit: true` — the user clicked an item. Persist whatever is currently
 *    live (so the preview becomes permanent). If the live theme matches the
 *    pre-preview original, nothing is persisted.
 *  - `commit: false` — the dropdown was dismissed without a pick. Restore the
 *    original theme (no persist — it was already persisted when it first became
 *    current, so the TOML is untouched).
 *
 * Always safe to call; no-op if no session is open.
 */
export function endThemePreview(commit: boolean): void {
  if (!previewOriginal) return;
  const orig = previewOriginal;
  previewOriginal = null;
  previewSeq++; // invalidate any in-flight loads
  if (commit) {
    if (current && current.id !== orig.id) {
      schedulePersist({
        themeId: current.id.startsWith("custom:") ? null : current.id,
        customThemePath: current.id.startsWith("custom:")
          ? current.id.slice("custom:".length)
          : null,
      });
    }
  } else {
    if (current && current.id !== orig.id) {
      broadcast(orig);
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Read the persisted theme from `AppearanceConfig` and apply it. Swallows
 * errors so a non-Tauri environment (vitest, browser dev) keeps the
 * static `:root` defaults from `styles.css`.
 */
export async function loadThemeFromConfig(): Promise<RaumTheme | null> {
  let snapshot: AppearanceSnapshot;
  try {
    snapshot = await invoke<AppearanceSnapshot>("config_get");
  } catch {
    return null;
  }
  const customPath = snapshot.appearance?.custom_theme_path;
  if (customPath) {
    try {
      return await loadAndApplyCustomTheme(customPath);
    } catch (e) {
      console.warn(
        `[theme] failed to load custom theme "${customPath}", falling back to default`,
        e,
      );
      return loadAndApplyTheme(DEFAULT_THEME_ID);
    }
  }
  const themeId = snapshot.appearance?.theme_id ?? DEFAULT_THEME_ID;
  return loadAndApplyTheme(themeId);
}
