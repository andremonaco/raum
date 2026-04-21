/**
 * Keyboard-shortcuts editor modal.
 *
 * Lists every keymap action, grouped by category. Each row shows the
 * effective accelerator; clicking "Edit" captures the next key combination
 * and persists it via `keymap_set_override`. "Reset" removes the user
 * override so the default takes over again. The live `KeymapProvider`
 * entries signal is updated after every successful write, so rebindings
 * take effect immediately without a restart.
 */

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import {
  acceleratorFromEvent,
  normaliseAccelerator,
  useKeymap,
  type KeymapEntry,
} from "../lib/keymapContext";
import { KeyboardIcon, SearchIcon } from "./icons";
import { Kbd, KbdGroup } from "./ui/kbd";
import { Badge } from "./ui/badge";
import { Scrollable } from "./ui/scrollable";

// ---------------------------------------------------------------------------
// Category grouping — mirrors the section comments in
// src-tauri/src/keymap.rs so the UI reflects the same mental model.
// ---------------------------------------------------------------------------

const CATEGORY_ORDER = ["Spawn", "Navigation", "Panes", "Chrome", "Worktrees", "Global"] as const;
type Category = (typeof CATEGORY_ORDER)[number];

const CATEGORY_BY_ACTION: Record<string, Category> = {
  "spawn-shell": "Spawn",
  "spawn-claude-code": "Spawn",
  "spawn-codex": "Spawn",
  "spawn-opencode": "Spawn",
  "cycle-tab-next": "Navigation",
  "cycle-tab-prev": "Navigation",
  "select-project-1": "Navigation",
  "select-project-2": "Navigation",
  "select-project-3": "Navigation",
  "select-project-4": "Navigation",
  "select-project-5": "Navigation",
  "select-project-6": "Navigation",
  "select-project-7": "Navigation",
  "select-project-8": "Navigation",
  "select-project-9": "Navigation",
  "select-filter-active": "Navigation",
  "select-filter-needs-input": "Navigation",
  "select-filter-recent": "Navigation",
  "focus-pane-1": "Panes",
  "focus-pane-2": "Panes",
  "focus-pane-3": "Panes",
  "focus-pane-4": "Panes",
  "focus-pane-5": "Panes",
  "focus-pane-6": "Panes",
  "focus-pane-7": "Panes",
  "focus-pane-8": "Panes",
  "focus-pane-9": "Panes",
  "cycle-focus-forward": "Panes",
  "cycle-focus-back": "Panes",
  "maximize-pane": "Panes",
  "toggle-sidebar": "Chrome",
  "toggle-quick-fire": "Chrome",
  "focus-quick-fire": "Chrome",
  "global-search": "Chrome",
  "cheat-sheet": "Chrome",
  spotlight: "Chrome",
  "new-worktree": "Worktrees",
  "switch-worktree": "Worktrees",
  "focus-raum": "Global",
  "spawn-shell-global": "Global",
};

function categoryFor(action: string): Category {
  return CATEGORY_BY_ACTION[action] ?? "Chrome";
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

interface Row {
  action: string;
  description: string;
  effective: string;
  default: string;
  overridden: boolean;
  global: boolean;
  category: Category;
}

function buildRows(effective: KeymapEntry[], defaults: KeymapEntry[]): Row[] {
  const defaultsByAction = new Map<string, KeymapEntry>();
  for (const d of defaults) defaultsByAction.set(d.action, d);

  const rows: Row[] = [];
  for (const e of effective) {
    const def = defaultsByAction.get(e.action);
    rows.push({
      action: e.action,
      description: e.description,
      effective: e.accelerator,
      default: def?.accelerator ?? e.accelerator,
      overridden: !!def && def.accelerator !== e.accelerator,
      global: e.global,
      category: categoryFor(e.action),
    });
  }
  rows.sort((a, b) => a.description.localeCompare(b.description));
  return rows;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface KeymapSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export const KeymapSettingsModal: Component<KeymapSettingsModalProps> = (props) => {
  const keymap = useKeymap();
  const [filter, setFilter] = createSignal("");
  const [editingAction, setEditingAction] = createSignal<string | null>(null);
  const [rowError, setRowError] = createSignal<{ action: string; message: string } | null>(null);

  // Close on Escape (idle rows) — while a row is capturing, Escape cancels
  // the capture instead (see beginCapture).
  function onGlobalKeydown(e: KeyboardEvent): void {
    if (!props.open) return;
    if (editingAction() !== null) return;
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  }
  window.addEventListener("keydown", onGlobalKeydown, { capture: true });
  onCleanup(() => window.removeEventListener("keydown", onGlobalKeydown, { capture: true }));

  // Reset UI state each time the modal (re)opens.
  createEffect(() => {
    if (props.open) {
      setFilter("");
      setEditingAction(null);
      setRowError(null);
    }
  });

  // -------------------------------------------------------------------------
  // Row data
  // -------------------------------------------------------------------------

  const rows = createMemo(() => buildRows(keymap.entries(), keymap.defaults()));

  const filteredRows = createMemo(() => {
    const q = filter().toLowerCase().trim();
    if (!q) return rows();
    return rows().filter(
      (r) =>
        r.action.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.effective.toLowerCase().includes(q),
    );
  });

  const groupedRows = createMemo(() => {
    const groups = new Map<Category, Row[]>();
    for (const r of filteredRows()) {
      const list = groups.get(r.category) ?? [];
      list.push(r);
      groups.set(r.category, list);
    }
    return CATEGORY_ORDER.filter((c) => (groups.get(c)?.length ?? 0) > 0).map((c) => ({
      category: c,
      rows: groups.get(c)!,
    }));
  });

  // Used for live conflict preview while capturing.
  const acceleratorLookup = createMemo(() => {
    const map = new Map<string, string>();
    for (const e of keymap.entries()) {
      map.set(normaliseAccelerator(e.accelerator), e.action);
    }
    return map;
  });

  // -------------------------------------------------------------------------
  // Capture + persist
  // -------------------------------------------------------------------------

  async function saveOverride(action: string, accelerator: string): Promise<void> {
    try {
      const next = await invoke<KeymapEntry[]>("keymap_set_override", {
        action,
        accelerator,
      });
      keymap.replaceEntries(next);
      setEditingAction(null);
      setRowError(null);
    } catch (e) {
      setRowError({ action, message: String(e) });
    }
  }

  async function clearOverride(action: string): Promise<void> {
    try {
      const next = await invoke<KeymapEntry[]>("keymap_clear_override", { action });
      keymap.replaceEntries(next);
      setRowError(null);
    } catch (e) {
      setRowError({ action, message: String(e) });
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-scrim"
        onClick={() => props.onClose()}
      >
        <div
          class="floating-surface animate-in fade-in zoom-in-95 duration-150 w-full max-w-[720px] mx-4 flex max-h-[76vh] flex-col overflow-hidden rounded-2xl border border-border bg-popover"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div class="flex items-center gap-3 border-b border-white/5 px-4 py-3.5">
            <KeyboardIcon class="size-4 shrink-0 text-muted-foreground/70" />
            <span class="text-sm font-medium text-foreground">Keyboard shortcuts</span>
            <div class="ml-auto flex items-center gap-2">
              <div class="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1">
                <SearchIcon class="size-3.5 shrink-0 text-muted-foreground/60" />
                <input
                  type="text"
                  class="w-40 min-w-0 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
                  placeholder="Filter actions…"
                  value={filter()}
                  onInput={(e) => setFilter(e.currentTarget.value)}
                />
              </div>
            </div>
          </div>

          {/* Body */}
          <Scrollable class="min-h-0 flex-1">
            <Show
              when={groupedRows().length > 0}
              fallback={
                <p class="px-4 py-6 text-center text-xs text-muted-foreground/60">
                  No actions match "{filter()}".
                </p>
              }
            >
              <For each={groupedRows()}>
                {(group) => (
                  <>
                    <div class="flex items-center gap-2 px-4 pb-1 pt-3">
                      <span class="text-[10px] uppercase tracking-widest text-muted-foreground/50">
                        {group.category}
                      </span>
                      <span class="text-[10px] text-muted-foreground/40">{group.rows.length}</span>
                    </div>
                    <For each={group.rows}>
                      {(row) => (
                        <ShortcutRow
                          row={row}
                          isEditing={editingAction() === row.action}
                          conflictLookup={acceleratorLookup}
                          errorMessage={
                            rowError()?.action === row.action ? rowError()!.message : null
                          }
                          onStartEdit={() => {
                            setEditingAction(row.action);
                            setRowError(null);
                          }}
                          onCancelEdit={() => setEditingAction(null)}
                          onCapture={(accel) => void saveOverride(row.action, accel)}
                          onReset={() => void clearOverride(row.action)}
                        />
                      )}
                    </For>
                  </>
                )}
              </For>
            </Show>
          </Scrollable>

          {/* Footer */}
          <div class="flex items-center justify-between border-t border-white/5 px-4 py-2 text-[11px] text-muted-foreground/70">
            <span>
              Overrides are saved to{" "}
              <code class="font-mono text-foreground/80">~/.config/raum/keybindings.toml</code>.
            </span>
            <button
              type="button"
              class="rounded px-2 py-1 hover:bg-white/5 hover:text-foreground"
              onClick={() => props.onClose()}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

// ---------------------------------------------------------------------------
// ShortcutRow — handles idle vs. capture mode + reset button
// ---------------------------------------------------------------------------

const ShortcutRow: Component<{
  row: Row;
  isEditing: boolean;
  conflictLookup: () => Map<string, string>;
  errorMessage: string | null;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onCapture: (accel: string) => void;
  onReset: () => void;
}> = (props) => {
  const [pending, setPending] = createSignal<string | null>(null);

  // While editing, capture the next non-modifier keydown and translate it to
  // an accelerator string that matches the backend's grammar.
  createEffect(() => {
    if (!props.isEditing) {
      setPending(null);
      return;
    }
    const handler = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        props.onCancelEdit();
        return;
      }
      // Ignore pure-modifier presses — wait for a real key.
      if (e.key === "Meta" || e.key === "Control" || e.key === "Alt" || e.key === "Shift") {
        return;
      }
      const accel = buildBackendAccelerator(e);
      if (!accel) return;
      setPending(accel);
      props.onCapture(accel);
    };
    window.addEventListener("keydown", handler, { capture: true });
    onCleanup(() => window.removeEventListener("keydown", handler, { capture: true }));
  });

  const conflict = createMemo(() => {
    const p = pending();
    if (!p) return null;
    const action = props.conflictLookup().get(normaliseAccelerator(p));
    return action && action !== props.row.action ? action : null;
  });

  return (
    <div class="group flex flex-col gap-0.5 px-4 py-2 hover:bg-white/[0.03]">
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="truncate text-xs text-foreground/90">{props.row.description}</span>
            <Show when={props.row.global}>
              <Badge class="shrink-0 bg-warning/10 px-1.5 py-0.5 text-[9px] font-medium text-warning">
                restart required
              </Badge>
            </Show>
            <Show when={props.row.overridden}>
              <Badge class="shrink-0 bg-white/5 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground/70">
                custom
              </Badge>
            </Show>
          </div>
          <div class="mt-0.5 font-mono text-[10px] text-muted-foreground/50">
            {props.row.action}
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-2">
          <Show
            when={props.isEditing}
            fallback={<AcceleratorTokens accelerator={props.row.effective} />}
          >
            <span class="rounded border border-dashed border-muted-foreground/40 px-2 py-0.5 text-[10px] text-muted-foreground/70">
              Press any keys — Esc to cancel
            </span>
          </Show>

          <Show when={!props.isEditing}>
            <button
              type="button"
              class="rounded px-2 py-0.5 text-[10px] text-muted-foreground/70 hover:bg-white/5 hover:text-foreground"
              onClick={() => props.onStartEdit()}
            >
              Edit
            </button>
            <button
              type="button"
              class="rounded px-2 py-0.5 text-[10px] text-muted-foreground/70 hover:bg-white/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              disabled={!props.row.overridden}
              onClick={() => props.onReset()}
              title={
                props.row.overridden
                  ? `Reset to default (${props.row.default})`
                  : "Already at default"
              }
            >
              Reset
            </button>
          </Show>
        </div>
      </div>

      <Show when={props.isEditing && conflict()}>
        <div class="pl-0 text-[10px] text-warning">
          Conflicts with <span class="font-mono">{conflict()}</span> — last wins
        </div>
      </Show>

      <Show when={props.errorMessage}>
        <div class="pl-0 text-[10px] text-destructive">{props.errorMessage}</div>
      </Show>
    </div>
  );
};

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/** Pretty-print a single accelerator token (modifier or key) for the UI. */
function prettifyToken(token: string): string {
  if (IS_MAC) {
    switch (token) {
      case "Meta":
      case "CmdOrCtrl":
      case "Cmd":
      case "Command":
        return "⌘";
      case "Ctrl":
      case "Control":
        return "⌃";
      case "Alt":
      case "Option":
        return "⌥";
      case "Shift":
        return "⇧";
      case "Up":
        return "↑";
      case "Down":
        return "↓";
      case "Left":
        return "←";
      case "Right":
        return "→";
    }
  } else {
    switch (token) {
      case "Meta":
      case "CmdOrCtrl":
      case "Cmd":
      case "Command":
      case "Ctrl":
      case "Control":
        return "Ctrl";
      case "Alt":
      case "Option":
        return "Alt";
      case "Shift":
        return "Shift";
    }
  }
  return token;
}

const AcceleratorTokens: Component<{ accelerator: string }> = (props) => {
  const tokens = createMemo(() => props.accelerator.split("+").filter(Boolean));
  return (
    <KbdGroup>
      <For each={tokens()}>{(t) => <Kbd>{prettifyToken(t)}</Kbd>}</For>
    </KbdGroup>
  );
};

// ---------------------------------------------------------------------------
// Accelerator translation for the backend
// ---------------------------------------------------------------------------

/**
 * Build a backend-style accelerator string (e.g. `"CmdOrCtrl+Shift+F"`) from
 * a `KeyboardEvent`. Re-uses `acceleratorFromEvent` to get the canonical
 * frontend representation and then remaps `Meta`/`Ctrl` to `CmdOrCtrl` so the
 * stored override is portable across platforms. The backend grammar accepts
 * single-character keys directly (see `is_key_token` in
 * `src-tauri/src/keymap.rs`), so no further remapping is needed.
 *
 * Returns `null` if the event has no non-modifier key.
 */
function buildBackendAccelerator(e: KeyboardEvent): string | null {
  const raw = acceleratorFromEvent(e);
  const parts = raw.split("+").filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1];
  if (!key || key === "Meta" || key === "Ctrl" || key === "Alt" || key === "Shift") return null;

  const mods = parts.slice(0, -1);
  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  const mapped = mods.map((m) => {
    if (m === "Meta" && isMac) return "CmdOrCtrl";
    if (m === "Ctrl" && !isMac) return "CmdOrCtrl";
    return m;
  });

  return [...mapped, key].join("+");
}

export default KeymapSettingsModal;
