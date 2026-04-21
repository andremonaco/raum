/**
 * §12.4–12.6 — in-app keymap provider + cheat-sheet wiring.
 *
 * Architecture:
 *
 *   • On mount the provider calls `keymap_get_effective` (merged defaults +
 *     user overrides, §12.2) and builds an action→accelerator map plus the
 *     inverse accelerator→action lookup.
 *   • A window-scoped `keydown` listener normalises the incoming event into
 *     the same accelerator format, looks up the action, and invokes the
 *     **most recently registered** handler for that action (§12.5
 *     "last-registered wins").
 *   • Components register handlers through the `useKeymapAction(action, fn)`
 *     hook — cleanup is automatic via Solid's `onCleanup`. The legacy
 *     imperative `register(action, fn)` / `dispatch(action)` surface from
 *     the Wave-3B stub is preserved for existing callers (e.g. TopRow).
 *   • Load-time conflict detection walks the effective keymap and flags
 *     two actions colliding on the same accelerator. The warning is
 *     logged to the console and emitted on the `keymap-conflict` Tauri
 *     event so the UI can surface it in the event log (§12.5).
 */

import { invoke } from "@tauri-apps/api/core";
import { emit as emitTauriEvent } from "@tauri-apps/api/event";
import {
  createContext,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  useContext,
  type Accessor,
  type Component,
  type JSX,
} from "solid-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KeymapEntry {
  action: string;
  accelerator: string;
  description: string;
  global: boolean;
}

export interface KeymapConflict {
  accelerator: string;
  actions: string[];
}

type Handler = (event?: KeyboardEvent) => void;

export interface KeymapApi {
  /** Effective keymap (defaults merged with `keybindings.toml` overrides). */
  entries: Accessor<KeymapEntry[]>;
  /** Default keymap shipped with raum — used by the cheat sheet. */
  defaults: Accessor<KeymapEntry[]>;
  /** Accelerator collisions detected at load time (§12.5). */
  conflicts: Accessor<KeymapConflict[]>;
  /** Effective accelerator for `action`, or `undefined` if unknown. */
  accelerator(action: string): string | undefined;
  /**
   * Register a handler for `action`. Returns an unregister function.
   * Handlers stack — the most recently registered handler runs first
   * (§12.5); on unregister, the next-most-recent becomes active again.
   */
  register(action: string, handler: Handler): () => void;
  /** Invoke the top-of-stack handler for `action`. Returns whether one ran. */
  dispatch(action: string, event?: KeyboardEvent): boolean;
  /**
   * Replace the effective keymap with the result of a successful save
   * (`keymap_set_override` / `keymap_clear_override`). Lets the editor
   * modal apply changes without reloading from disk.
   */
  replaceEntries(next: KeymapEntry[]): void;
}

const KeymapContext = createContext<KeymapApi | undefined>(undefined);

// ---------------------------------------------------------------------------
// Accelerator normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise an accelerator string into a canonical form so user-authored
 * overrides like "ctrl+shift+f" match event-derived strings like
 * "Ctrl+Shift+F".
 *
 *   - tokens split on `+`, trimmed, non-empty
 *   - modifiers canonicalised (Cmd/Command/CmdOrCtrl → platform-appropriate)
 *   - single-character keys upper-cased
 *   - modifier tokens sorted in stable order (Meta, Ctrl, Alt, Shift)
 */
export function normaliseAccelerator(raw: string): string {
  const tokens = raw
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return "";

  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

  const modMap: Record<string, string> = {
    cmd: isMac ? "Meta" : "Ctrl",
    command: isMac ? "Meta" : "Ctrl",
    cmdorctrl: isMac ? "Meta" : "Ctrl",
    commandorcontrol: isMac ? "Meta" : "Ctrl",
    meta: "Meta",
    super: "Meta",
    ctrl: "Ctrl",
    control: "Ctrl",
    alt: "Alt",
    option: "Alt",
    altgr: "Alt",
    shift: "Shift",
  };

  const modifierRank: Record<string, number> = {
    Meta: 0,
    Ctrl: 1,
    Alt: 2,
    Shift: 3,
  };

  const mods: string[] = [];
  let key = "";
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (lower in modMap) {
      mods.push(modMap[lower]!);
    } else {
      key = t.length === 1 ? t.toUpperCase() : t;
    }
  }
  const deduped = Array.from(new Set(mods));
  deduped.sort((a, b) => (modifierRank[a] ?? 99) - (modifierRank[b] ?? 99));
  return [...deduped, key].filter(Boolean).join("+");
}

/** Build the canonical accelerator for a `KeyboardEvent`. */
export function acceleratorFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey) parts.push("Meta");
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  let key = e.key;
  if (e.code.startsWith("Key") && e.code.length === 4) {
    // "KeyF" → "F"
    key = e.code.slice(3);
  } else if (e.code.startsWith("Digit") && e.code.length === 6) {
    // "Digit1" → "1"
    key = e.code.slice(5);
  } else {
    const named: Record<string, string> = {
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      " ": "Space",
      Spacebar: "Space",
      Escape: "Escape",
      Enter: "Enter",
      Backspace: "Backspace",
      Delete: "Delete",
      Tab: "Tab",
    };
    if (key in named) key = named[key]!;
    else if (key.length === 1) key = key.toUpperCase();
  }
  parts.push(key);
  return parts.join("+");
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface KeymapProviderProps {
  children: JSX.Element;
  /** Test-only override so Vitest doesn't need a live Tauri host. */
  initial?: KeymapEntry[];
  /** Test-only default-keymap override (for the cheat-sheet). */
  initialDefaults?: KeymapEntry[];
}

export const KeymapProvider: Component<KeymapProviderProps> = (props) => {
  const [entries, setEntries] = createSignal<KeymapEntry[]>(props.initial ?? []);
  const [defaults, setDefaults] = createSignal<KeymapEntry[]>(props.initialDefaults ?? []);

  // Handler stack per action. We push on register and splice on unregister;
  // dispatch runs the top-of-stack handler (last-registered wins, §12.5).
  const handlers = new Map<string, Handler[]>();

  const acceleratorToAction = createMemo(() => {
    const map = new Map<string, string>();
    for (const entry of entries()) {
      const key = normaliseAccelerator(entry.accelerator);
      // Last-registered wins: later entries simply overwrite earlier ones
      // in the lookup map.
      if (key) map.set(key, entry.action);
    }
    return map;
  });

  const conflicts = createMemo<KeymapConflict[]>(() => {
    const groups = new Map<string, string[]>();
    for (const entry of entries()) {
      const key = normaliseAccelerator(entry.accelerator);
      if (!key) continue;
      const list = groups.get(key) ?? [];
      list.push(entry.action);
      groups.set(key, list);
    }
    const out: KeymapConflict[] = [];
    for (const [accelerator, actions] of groups.entries()) {
      if (actions.length > 1) out.push({ accelerator, actions });
    }
    return out;
  });

  function register(action: string, handler: Handler): () => void {
    const stack = handlers.get(action) ?? [];
    stack.push(handler);
    handlers.set(action, stack);
    return () => {
      const cur = handlers.get(action);
      if (!cur) return;
      const idx = cur.lastIndexOf(handler);
      if (idx >= 0) cur.splice(idx, 1);
      if (cur.length === 0) handlers.delete(action);
    };
  }

  function dispatch(action: string, event?: KeyboardEvent): boolean {
    const stack = handlers.get(action);
    if (!stack || stack.length === 0) return false;
    const top = stack[stack.length - 1]!;
    try {
      top(event);
    } catch (e) {
      console.error(`[keymap] handler for ${action} threw`, e);
    }
    return true;
  }

  function onKeydown(e: KeyboardEvent): void {
    // Typing into a textfield / contenteditable shouldn't accidentally
    // trigger keymap actions (Cmd+A → select-all, not spawn-agent). We
    // still allow a small allow-list of globally-scoped actions so users
    // can open the cheat-sheet or global search from an input.
    const target = e.target as HTMLElement | null;
    if (target) {
      const tag = target.tagName;
      const editable = target.isContentEditable;
      if (editable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        const accel = acceleratorFromEvent(e);
        const action = acceleratorToAction().get(accel);
        if (!action) return;
        if (
          action !== "cheat-sheet" &&
          action !== "global-search" &&
          action !== "toggle-sidebar" &&
          action !== "spotlight" &&
          action !== "reload"
        ) {
          return;
        }
        if (dispatch(action, e)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
    }

    const accel = acceleratorFromEvent(e);
    const action = acceleratorToAction().get(accel);
    if (!action) return;
    if (dispatch(action, e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  async function loadKeymap(): Promise<void> {
    if (!props.initial) {
      try {
        const effective = await invoke<KeymapEntry[]>("keymap_get_effective");
        setEntries(effective);
      } catch (e) {
        console.warn("keymap_get_effective failed", e);
      }
    }
    if (!props.initialDefaults) {
      try {
        const d = await invoke<{ bindings: KeymapEntry[] }>("keymap_get_defaults");
        setDefaults(d.bindings);
      } catch (e) {
        console.warn("keymap_get_defaults failed", e);
      }
    }

    // §12.5 — surface conflicts at load time.
    const found = conflicts();
    if (found.length > 0) {
      for (const c of found) {
        console.warn(
          `[keymap] accelerator ${c.accelerator} resolves to ${c.actions.length} actions; last wins`,
          c.actions,
        );
      }
      try {
        await emitTauriEvent("keymap-conflict", found);
      } catch {
        // Tauri event bus unavailable (e.g. in vitest); the console warn is enough.
      }
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKeydown, { capture: true });
    void loadKeymap();
  });

  onCleanup(() => {
    window.removeEventListener("keydown", onKeydown, { capture: true });
    handlers.clear();
  });

  const api: KeymapApi = {
    entries,
    defaults,
    conflicts,
    accelerator(action) {
      return entries().find((e) => e.action === action)?.accelerator;
    },
    register,
    dispatch,
    replaceEntries: setEntries,
  };

  return <KeymapContext.Provider value={api}>{props.children}</KeymapContext.Provider>;
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useKeymap(): KeymapApi {
  const ctx = useContext(KeymapContext);
  if (!ctx) {
    // Dead-end API so components can render outside the provider (e.g. in
    // shallow tests) without crashing. All methods are no-ops.
    return {
      entries: () => [],
      defaults: () => [],
      conflicts: () => [],
      accelerator: () => undefined,
      register: () => () => undefined,
      dispatch: () => false,
      replaceEntries: () => undefined,
    };
  }
  return ctx;
}

/**
 * Register a handler for `action`. The registration is torn down on owner
 * cleanup automatically.
 */
export function useKeymapAction(action: string, fn: Handler): void {
  const api = useKeymap();
  const unregister = api.register(action, fn);
  onCleanup(unregister);
}

/** Convenience: read the effective accelerator for `action` reactively. */
export function useAccelerator(action: string): Accessor<string | undefined> {
  const api = useKeymap();
  return createMemo(() => api.accelerator(action));
}
