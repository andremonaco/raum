/**
 * §10.2 — layout preset library.
 *
 * Solid `createStore`-backed mirror of `~/.config/raum/layouts.toml`, kept in
 * sync with the Rust side via three Tauri commands:
 *
 *   * `layouts_list()` — fetch every preset.
 *   * `layouts_save(preset)` — upsert by name; returns the new list.
 *   * `layouts_delete(name)` — remove a preset + clear dangling worktree
 *     pointers (§10.5).
 *
 * Writes are debounced on the JS side at 500 ms (§10.9). Rapid "save" calls
 * within the window collapse into a single Tauri invoke carrying the latest
 * payload. The store optimistically updates immediately so the UI feels
 * instantaneous; on failure the store reverts by re-fetching from disk.
 *
 * On-disk shape matches `raum_core::config::LayoutPreset`:
 *   `{ name, created_at?, cells: LayoutCell[] }`
 * where each cell carries `{ x, y, w, h, kind, title? }`.
 *
 * Wave 3B seeded a thinner stub (`upsertPreset` / `removePreset` / `setPresets`);
 * Wave 3D owns the full implementation. The old named exports are preserved as
 * thin wrappers so any in-flight references keep compiling.
 */

import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";

import type { AgentKind } from "../lib/agentKind";

/** Matches `raum_core::config::LayoutCell`. `"empty"` is a UI-only placeholder
 *  for an unconfigured cell in `<GridBuilder>`; it is never persisted because
 *  `AgentKind` on the Rust side does not include it. The `GridBuilder` filters
 *  empty cells out before saving. */
export type CellKind = AgentKind | "empty";

export interface LayoutCell {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: CellKind;
  title?: string;
}

export interface LayoutPreset {
  name: string;
  created_at?: number;
  cells: LayoutCell[];
}

interface LayoutPresetState {
  presets: LayoutPreset[];
  loaded: boolean;
}

const [layoutPresetStore, setLayoutPresetStore] = createStore<LayoutPresetState>({
  presets: [],
  loaded: false,
});

const [lastError, setLastError] = createSignal<string | null>(null);

export { layoutPresetStore, lastError };

/** Lookup by name; returns `undefined` if not loaded or not found. */
export function getPreset(name: string): LayoutPreset | undefined {
  return layoutPresetStore.presets.find((p) => p.name === name);
}

/**
 * Fetch every preset from the Rust backend and hydrate the store. Safe to call
 * repeatedly; subsequent calls act as a "reload". Errors are surfaced via
 * `lastError()`.
 */
export async function loadLayoutPresets(): Promise<LayoutPreset[]> {
  try {
    const presets = await invoke<LayoutPreset[]>("layouts_list");
    setLayoutPresetStore("presets", reconcile(presets, { key: "name" }));
    setLayoutPresetStore("loaded", true);
    setLastError(null);
    return presets;
  } catch (err) {
    const msg = String(err);
    console.error("[layoutPresetStore] layouts_list failed", err);
    setLastError(msg);
    setLayoutPresetStore("loaded", true);
    return [];
  }
}

// ---- §10.9 debouncer -------------------------------------------------------

/**
 * A tiny named-key debouncer: `schedule("foo", fn, 500)` coalesces rapid calls
 * keyed on "foo" so only the last `fn` runs after the quiet window. Used here
 * for `savePreset` (key = preset name) so a drag-and-save loop only hits the
 * backend once per 500 ms.
 */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingActions = new Map<string, () => Promise<void>>();

export function schedule(key: string, fn: () => Promise<void>, delayMs = 500): void {
  pendingActions.set(key, fn);
  const prev = timers.get(key);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(key);
    const action = pendingActions.get(key);
    pendingActions.delete(key);
    if (action) void action();
  }, delayMs);
  timers.set(key, t);
}

/** Flush any pending `schedule` calls immediately. Test + shutdown helper. */
export async function flushScheduled(): Promise<void> {
  const entries = Array.from(pendingActions.entries());
  for (const [key, fn] of entries) {
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.delete(key);
    pendingActions.delete(key);
    await fn();
  }
}

// ---- mutations -------------------------------------------------------------

/** Drop cells whose `kind === "empty"` so on-disk payloads match the Rust
 *  `AgentKind` enum (which doesn't include `"empty"`). */
function sanitize(preset: LayoutPreset): LayoutPreset {
  return {
    ...preset,
    cells: preset.cells.filter((c) => c.kind !== "empty"),
  };
}

/**
 * Upsert a preset. Immediately updates the store (optimistic); the actual
 * `layouts_save` Tauri invoke runs after the 500 ms debounce window closes.
 */
export function savePreset(preset: LayoutPreset): void {
  const trimmed = preset.name.trim();
  if (trimmed.length === 0) {
    setLastError("preset name must be non-empty");
    return;
  }
  const local: LayoutPreset = { ...preset, name: trimmed };
  const idx = layoutPresetStore.presets.findIndex((p) => p.name === trimmed);
  if (idx === -1) {
    setLayoutPresetStore("presets", (prev) => [...prev, local]);
  } else {
    setLayoutPresetStore("presets", idx, local);
  }
  const onDisk = sanitize(local);
  schedule(`save:${trimmed}`, async () => {
    try {
      const updated = await invoke<LayoutPreset[]>("layouts_save", {
        preset: onDisk,
      });
      setLayoutPresetStore("presets", reconcile(updated, { key: "name" }));
      setLayoutPresetStore("loaded", true);
      setLastError(null);
    } catch (err) {
      console.error("[layoutPresetStore] layouts_save failed", err);
      setLastError(String(err));
      void loadLayoutPresets();
    }
  });
}

/**
 * "Save as new preset" variant (§10.6). Errors when a preset with the same
 * name already exists so the user isn't silently overwriting.
 */
export function createPreset(preset: LayoutPreset): { ok: boolean; error?: string } {
  const trimmed = preset.name.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "preset name must be non-empty" };
  }
  if (layoutPresetStore.presets.some((p) => p.name === trimmed)) {
    return { ok: false, error: `preset already exists: ${trimmed}` };
  }
  savePreset({ ...preset, name: trimmed });
  return { ok: true };
}

/**
 * Delete a preset. Immediately removes it from the store (optimistic); the
 * actual `layouts_delete` invoke runs after 500 ms. Any worktree pointer
 * referencing this preset is cleared backend-side (§10.5).
 */
export function deletePreset(name: string): void {
  setLayoutPresetStore("presets", (prev) => prev.filter((p) => p.name !== name));
  schedule(`delete:${name}`, async () => {
    try {
      const updated = await invoke<LayoutPreset[]>("layouts_delete", { name });
      setLayoutPresetStore("presets", reconcile(updated, { key: "name" }));
      setLayoutPresetStore("loaded", true);
      setLastError(null);
    } catch (err) {
      console.error("[layoutPresetStore] layouts_delete failed", err);
      setLastError(String(err));
      void loadLayoutPresets();
    }
  });
}

// ---- back-compat wrappers for the Wave 3B stub ----------------------------

export function setPresets(items: LayoutPreset[]): void {
  setLayoutPresetStore("presets", reconcile(items, { key: "name" }));
  setLayoutPresetStore("loaded", true);
}

/** Synchronous in-memory upsert; does NOT invoke `layouts_save`. Prefer
 *  `savePreset` for persisted changes. */
export function upsertPreset(preset: LayoutPreset): void {
  const idx = layoutPresetStore.presets.findIndex((p) => p.name === preset.name);
  if (idx === -1) {
    setLayoutPresetStore("presets", (prev) => [...prev, preset]);
  } else {
    setLayoutPresetStore("presets", idx, preset);
  }
}

/** Synchronous in-memory remove; does NOT invoke `layouts_delete`. Prefer
 *  `deletePreset` for persisted changes. */
export function removePreset(name: string): void {
  setLayoutPresetStore("presets", (prev) => prev.filter((p) => p.name !== name));
}

/** Test-only helper: reset the store to a known state. */
export function __resetLayoutStoreForTests(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  pendingActions.clear();
  setLayoutPresetStore({ presets: [], loaded: false });
  setLastError(null);
}
