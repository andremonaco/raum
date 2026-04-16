/**
 * §10.3 — `<GridBuilder>`: an empty-canvas editor for composing a new preset
 * before committing to tmux.
 *
 *   - Drag / resize cells via a local Gridstack instance (separate from the
 *     runtime grid so the user can experiment without disturbing live agents).
 *   - Per-cell kind picker: shell / claude-code / codex / opencode / empty.
 *   - Optional title.
 *   - Preview pane renders a miniature read-only layout.
 *   - "Save" flushes through `layoutPresetStore.createPreset` (fails loudly on
 *     name collision) or `savePreset` when an existing preset is being edited.
 *
 * The builder lives in a dismissable panel; mount/unmount is controlled by the
 * parent via the `open` prop so state resets cleanly per invocation.
 */

import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";

import { initGrid, onChange, type GridHandle } from "../lib/gridstackAdapter";
import {
  createPreset,
  savePreset,
  type CellKind,
  type LayoutPreset,
} from "../stores/layoutPresetStore";

interface BuilderCell {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: CellKind;
  title?: string;
}

const KIND_OPTIONS: CellKind[] = ["shell", "claude-code", "codex", "opencode", "empty"];

export interface GridBuilderProps {
  open: boolean;
  onClose: () => void;
  /** When editing an existing preset, pass it in — the builder populates the
   *  canvas and the save button targets `savePreset` instead of `createPreset`. */
  initial?: LayoutPreset | null;
}

let builderIdCounter = 0;
function nextBuilderId(): string {
  builderIdCounter += 1;
  return `builder-cell-${builderIdCounter}`;
}

export const GridBuilder: Component<GridBuilderProps> = (props) => {
  let host: HTMLDivElement | undefined;
  const [handle, setHandle] = createSignal<GridHandle | null>(null);
  const [cells, setCells] = createSignal<BuilderCell[]>(
    (props.initial?.cells ?? []).map((c) => ({
      id: nextBuilderId(),
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      kind: c.kind,
      title: c.title,
    })),
  );
  const [name, setName] = createSignal(props.initial?.name ?? "");
  const [error, setError] = createSignal<string | null>(null);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);

  onMount(() => {
    if (!host) return;
    const h = initGrid(host, { column: 12, cellHeight: 48 });
    if (!h) return;
    setHandle(h);
    const unsub = onChange(h, (snapshot) => {
      setCells((prev) =>
        prev.map((c) => {
          const next = snapshot.find((s) => s.id === c.id);
          return next ? { ...c, x: next.x, y: next.y, w: next.w, h: next.h } : c;
        }),
      );
    });
    onCleanup(() => {
      unsub();
      h.destroy();
    });
  });

  function addCell(): void {
    const id = nextBuilderId();
    setCells((prev) => [...prev, { id, x: 0, y: 0, w: 4, h: 4, kind: "shell" }]);
    // Add to gridstack after the DOM renders.
    queueMicrotask(() => {
      const h = handle();
      if (!h) return;
      const el = host?.querySelector(`[data-builder-id="${id}"]`);
      if (el) {
        try {
          h.grid.makeWidget(el as HTMLElement);
        } catch (err) {
          console.warn("[GridBuilder] makeWidget failed", err);
        }
      }
    });
  }

  function removeCell(id: string): void {
    const h = handle();
    const el = host?.querySelector(`[data-builder-id="${id}"]`);
    if (h && el) {
      try {
        h.grid.removeWidget(el as HTMLElement, true);
      } catch (err) {
        console.warn("[GridBuilder] removeWidget failed", err);
      }
    }
    setCells((prev) => prev.filter((c) => c.id !== id));
    if (selectedId() === id) setSelectedId(null);
  }

  function updateCell(id: string, patch: Partial<BuilderCell>): void {
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function toPreset(): LayoutPreset {
    return {
      name: name().trim(),
      created_at: Math.floor(Date.now() / 1000),
      cells: cells().map((c) => ({
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        kind: c.kind,
        ...(c.title ? { title: c.title } : {}),
      })),
    };
  }

  function onSave(): void {
    const preset = toPreset();
    if (preset.name.length === 0) {
      setError("name required");
      return;
    }
    if (preset.cells.length === 0) {
      setError("at least one cell required");
      return;
    }
    if (props.initial && props.initial.name === preset.name) {
      savePreset(preset);
      setError(null);
      props.onClose();
      return;
    }
    const res = createPreset(preset);
    if (!res.ok) {
      setError(res.error ?? "save failed");
      return;
    }
    setError(null);
    props.onClose();
  }

  const selected = () => cells().find((c) => c.id === selectedId()) ?? null;

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex bg-zinc-950/90 p-6"
        role="dialog"
        aria-label="Grid Builder"
      >
        <div class="flex h-full w-full flex-col rounded border border-zinc-800 bg-zinc-950 text-zinc-100">
          <header class="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs">
            <span>Grid Builder</span>
            <input
              type="text"
              class="ml-4 w-60 rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-xs"
              placeholder="Preset name…"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
            <button
              type="button"
              class="rounded bg-zinc-800 px-2 py-0.5 text-xs hover:bg-zinc-700"
              onClick={addCell}
            >
              + Add cell
            </button>
            <div class="ml-auto flex items-center gap-2">
              <Show when={error()}>
                <span class="text-xs text-red-400">{error()}</span>
              </Show>
              <button
                type="button"
                class="rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-900"
                onClick={() => props.onClose()}
              >
                Cancel
              </button>
              <button
                type="button"
                class="rounded bg-emerald-800 px-2 py-0.5 text-xs text-emerald-100 hover:bg-emerald-700"
                onClick={onSave}
              >
                Save preset
              </button>
            </div>
          </header>
          <div class="flex flex-1 min-h-0">
            <div class="flex-1 min-w-0 overflow-auto p-3">
              <div
                ref={(el) => (host = el)}
                class="grid-stack min-h-[400px] rounded border border-dashed border-zinc-800 bg-zinc-925"
              >
                <For each={cells()}>
                  {(cell) => (
                    <div
                      class="grid-stack-item"
                      gs-x={String(cell.x)}
                      gs-y={String(cell.y)}
                      gs-w={String(cell.w)}
                      gs-h={String(cell.h)}
                      data-builder-id={cell.id}
                      onClick={() => setSelectedId(cell.id)}
                    >
                      <div
                        class="grid-stack-item-content flex flex-col rounded border bg-zinc-900"
                        style={{
                          "border-color": selectedId() === cell.id ? "#f97316" : "#27272a",
                        }}
                      >
                        <div class="flex items-center justify-between border-b border-zinc-800 px-2 py-1 text-[10px] uppercase text-zinc-500">
                          <span class="truncate">{cell.title ?? cell.kind}</span>
                          <button
                            type="button"
                            class="text-zinc-500 hover:text-red-400"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeCell(cell.id);
                            }}
                            title="Remove"
                          >
                            ×
                          </button>
                        </div>
                        <div class="flex flex-1 items-center justify-center text-[11px] text-zinc-400">
                          {cell.kind}
                        </div>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
            <aside class="w-64 shrink-0 overflow-y-auto border-l border-zinc-800 p-3 text-xs">
              <h2 class="mb-2 text-[11px] uppercase tracking-wide text-zinc-500">Inspector</h2>
              <Show when={selected()} fallback={<p class="text-zinc-600">Click a cell to edit.</p>}>
                {(cell) => (
                  <div class="space-y-3">
                    <label class="block">
                      <span class="text-zinc-400">Kind</span>
                      <select
                        class="mt-1 block w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs"
                        value={cell().kind}
                        onChange={(e) =>
                          updateCell(cell().id, {
                            kind: e.currentTarget.value as CellKind,
                          })
                        }
                      >
                        <For each={KIND_OPTIONS}>{(k) => <option value={k}>{k}</option>}</For>
                      </select>
                    </label>
                    <label class="block">
                      <span class="text-zinc-400">Title (optional)</span>
                      <input
                        type="text"
                        class="mt-1 block w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs"
                        value={cell().title ?? ""}
                        onInput={(e) =>
                          updateCell(cell().id, {
                            title: e.currentTarget.value || undefined,
                          })
                        }
                      />
                    </label>
                    <div class="grid grid-cols-2 gap-2">
                      <Field
                        label="x"
                        value={cell().x}
                        onUpdate={(v) => updateCell(cell().id, { x: v })}
                      />
                      <Field
                        label="y"
                        value={cell().y}
                        onUpdate={(v) => updateCell(cell().id, { y: v })}
                      />
                      <Field
                        label="w"
                        value={cell().w}
                        onUpdate={(v) => updateCell(cell().id, { w: v })}
                      />
                      <Field
                        label="h"
                        value={cell().h}
                        onUpdate={(v) => updateCell(cell().id, { h: v })}
                      />
                    </div>
                    <button
                      type="button"
                      class="w-full rounded border border-red-900 bg-red-950/40 px-2 py-1 text-xs text-red-300 hover:bg-red-950"
                      onClick={() => removeCell(cell().id)}
                    >
                      Remove cell
                    </button>
                  </div>
                )}
              </Show>
              <hr class="my-4 border-zinc-800" />
              <h2 class="mb-2 text-[11px] uppercase tracking-wide text-zinc-500">Preview</h2>
              <PresetPreview cells={cells()} />
            </aside>
          </div>
        </div>
      </div>
    </Show>
  );
};

interface FieldProps {
  label: string;
  value: number;
  onUpdate: (v: number) => void;
}

const Field: Component<FieldProps> = (props) => (
  <label class="block">
    <span class="text-zinc-500">{props.label}</span>
    <input
      type="number"
      min="0"
      class="mt-1 block w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs"
      value={props.value}
      onInput={(e) => {
        const n = Number.parseInt(e.currentTarget.value, 10);
        if (Number.isFinite(n)) props.onUpdate(n);
      }}
    />
  </label>
);

// ---- preview ---------------------------------------------------------------

interface PresetPreviewProps {
  cells: BuilderCell[];
}

const PresetPreview: Component<PresetPreviewProps> = (props) => {
  const cols = 12;
  const rows = () => Math.max(4, ...props.cells.map((c) => c.y + c.h), 1);

  return (
    <div
      class="relative rounded border border-zinc-800 bg-zinc-950"
      style={{
        "aspect-ratio": `${cols} / ${rows()}`,
        width: "100%",
      }}
    >
      <For each={props.cells}>
        {(c) => (
          <div
            class="absolute rounded border border-zinc-700 bg-zinc-900/70 text-[9px] text-zinc-500"
            style={{
              left: `${(c.x / cols) * 100}%`,
              top: `${(c.y / rows()) * 100}%`,
              width: `${(c.w / cols) * 100}%`,
              height: `${(c.h / rows()) * 100}%`,
            }}
            title={c.title ?? c.kind}
          >
            <span class="absolute left-1 top-0.5 truncate">{c.title ?? c.kind}</span>
          </div>
        )}
      </For>
    </div>
  );
};

export default GridBuilder;
