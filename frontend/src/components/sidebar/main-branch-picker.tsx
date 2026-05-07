/**
 * §9 — main-worktree branch picker + raum logo glyph.
 *
 * Click-to-switch popover for the main worktree's branch badge. Loads the
 * local branch list via `worktree_branches`, refuses the switch on a dirty
 * tree (surfaces the backend error inline), and closes on success — the
 * `.git/HEAD` watcher will refresh the sidebar.
 *
 * `RaumLogo` is co-located here because the sidebar's only RaumLogo usage
 * is in the `Open in raum` context menu item, which lives next door in
 * `worktree-row.tsx`.
 */

import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import type { BranchListResult, MainBranchPickerProps } from "./types";

export const MainBranchPicker: Component<MainBranchPickerProps> = (props) => {
  const [data, setData] = createSignal<BranchListResult | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal<string | null>(null);
  const [switchError, setSwitchError] = createSignal<string | null>(null);

  onMount(() => {
    void (async () => {
      try {
        const r = await invoke<BranchListResult>("worktree_branches", {
          projectSlug: props.projectSlug,
        });
        setData(r);
      } catch (e) {
        setLoadError(String(e));
      }
    })();
  });

  const switchTo = async (branch: string) => {
    setSubmitting(branch);
    setSwitchError(null);
    try {
      await invoke<void>("git_checkout_branch", {
        projectSlug: props.projectSlug,
        branch,
      });
      props.onClose();
    } catch (e) {
      setSwitchError(String(e));
    } finally {
      setSubmitting(null);
    }
  };

  // Dismiss on outside click / Esc. The Portal means we can't rely on
  // sidebar-level mouseleave.
  onMount(() => {
    const onDoc = (ev: MouseEvent) => {
      const t = ev.target as Element | null;
      if (t && !t.closest("[data-branch-picker]")) props.onClose();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") props.onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    });
  });

  return (
    <Portal>
      <div
        data-branch-picker
        class="floating-surface fixed z-[70] w-56 overflow-hidden rounded-xl border border-border bg-popover p-1 text-xs"
        style={{ left: `${props.anchor.x}px`, top: `${props.anchor.y}px` }}
        role="menu"
      >
        <Show when={loadError()}>
          <p class="px-2 py-1.5 text-destructive">{loadError()}</p>
        </Show>
        <Show when={!loadError() && !data()}>
          <p class="px-2 py-1.5 text-foreground-dim">Loading branches…</p>
        </Show>
        <Show when={data()}>
          {(d) => (
            <>
              <div class="max-h-64 overflow-auto">
                <For each={d().branches}>
                  {(b) => {
                    const isCurrent = () => b === d().current;
                    const isBusy = () => submitting() === b;
                    return (
                      <button
                        type="button"
                        class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                        disabled={isCurrent() || submitting() !== null}
                        onClick={() => void switchTo(b)}
                      >
                        <span class="w-3 shrink-0 text-foreground-dim" aria-hidden="true">
                          {isCurrent() ? "✓" : isBusy() ? "…" : ""}
                        </span>
                        <span class="truncate font-mono">{b}</span>
                      </button>
                    );
                  }}
                </For>
              </div>
              <Show when={switchError()}>
                <p class="border-t border-border-subtle px-2 py-1.5 text-destructive">
                  {switchError()}
                </p>
              </Show>
            </>
          )}
        </Show>
      </div>
    </Portal>
  );
};

export function RaumLogo(props: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      stroke-width="8"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      aria-hidden="true"
    >
      <rect x="4" y="4" width="92" height="92" />
      <line x1="96" y1="4" x2="4" y2="50" />
      <line x1="96" y1="4" x2="4" y2="96" />
      <line x1="96" y1="4" x2="50" y2="96" />
    </svg>
  );
}
