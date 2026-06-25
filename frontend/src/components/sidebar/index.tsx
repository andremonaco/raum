/**
 * §9 — Sidebar root.
 *
 * Owned by Wave 3C. Starts from Wave 2B's worktree-list skeleton and layers on
 * the full spec:
 *
 *   §9.1 expandable worktree rows + dirty indicator (polls
 *        `worktree_status` every 2 s per worktree).
 *   §9.2 `Open` / `Staged` file groups, clickable via the Tauri
 *        opener plugin (`openPath` — delegates to `open` on macOS,
 *        `xdg-open` on Linux).
 *   §9.5 resize handle persists width into `config.toml.sidebar.width_px`
 *        via `config_set_sidebar_width`; collapse via the `toggle-sidebar`
 *        action from the keymap (listened through a window custom event so
 *        the future §12.4 keymap provider can dispatch us without this
 *        component importing the provider).
 *
 * Stores imported (from Wave 3B / 3D):
 *   • `projectStore` — project list, active slug, colors.
 *   • `worktreeStore` — the existing active-worktree tracking + cache.
 *
 * This module folder is the post-§9 split: each region (`worktree-row`,
 * `project-section`, `discard-confirm-dialog`, …) lives next door so the
 * root file stays scannable.
 */

import { Component, For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  ALL_WORKTREES_SCOPE,
  activeWorktreeStore,
  refreshWorktreeList,
  setActiveWorktree,
  setActiveWorktreeAll,
  worktreesByProject,
} from "../../stores/worktreeStore";
import { activeProjectSlug, projectStore, refreshProjects } from "../../stores/projectStore";
import { harnessCountsForProject, harnessCountsForWorktree } from "../../stores/terminalStore";
import { AlertCircleIcon, CheckIcon, GridEqualIcon, LoaderIcon } from "../icons";
import { useKeymapAction } from "../../lib/keymapContext";
import { sidebarHidden } from "../../lib/sidebarVisibility";
import { Scrollable } from "../ui/scrollable";
import { SIDEBAR_COLLAPSED_PX } from "./constants";
import { ProjectSection } from "./project-section";
import { ResizeHandle } from "./resize-handle";

// Re-exported so consumers that imported from `./components/sidebar` (e.g.
// the unit-test suite) don't need to know the file split happened.
export { buildCommitCommand, shellQuote } from "./git-commands";

export const Sidebar: Component = () => {
  const [width, setWidth] = createSignal(280);
  const [collapsed, setCollapsed] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [worktreeFilter, setWorktreeFilter] = createSignal("");
  // Tracks which project slug has its create-worktree modal open (null = closed).
  const [createModalSlug, setCreateModalSlug] = createSignal<string | null>(null);
  // Track the last value we persisted so the drag-end commit doesn't echo
  // the value we just loaded from disk back through `config_set_sidebar_width`.
  // Initialised to `undefined` so the first persisted width always gets
  // skipped (we never write on hydrate, only on user-driven changes).
  let lastPersisted: number | undefined;

  // Hydrate the persisted width + collapsed flag from `config.toml`. Falls
  // back to defaults when Tauri is absent (unit tests).
  onMount(() => {
    void (async () => {
      try {
        const cfg = await invoke<{
          sidebar: { widthPx?: number; width_px?: number; collapsed?: boolean };
        }>("config_get");
        const raw = cfg.sidebar?.widthPx ?? cfg.sidebar?.width_px;
        if (typeof raw === "number" && raw > 0) {
          lastPersisted = raw;
          setWidth(raw);
        } else {
          lastPersisted = width();
        }
        if (cfg.sidebar?.collapsed === true) setCollapsed(true);
      } catch {
        // Tauri unavailable — defaults are fine, seed `lastPersisted` from
        // the default signal so the first drag still triggers a write.
        lastPersisted = width();
      }
    })();
    // Hydrate projects on first mount.
    void refreshProjects();
  });

  // §9.7 — register the `toggle-sidebar` keymap action. `useKeymapAction`
  // plugs into the Wave-3F provider (§12.4), which normalises the accelerator
  // from `~/.config/raum/keybindings.toml` and dispatches us on match.
  // Rendered outside the provider (e.g. in unit tests), `useKeymap` returns
  // a no-op API so this is a safe call.
  useKeymapAction("toggle-sidebar", () => setCollapsed((v) => !v));
  // `new-worktree` (⌘⇧N) + the spotlight "New worktree" command both land
  // here: open the create-worktree modal for the active project (same as the
  // sidebar "+" button). No-op when no project is active. Previously the
  // accelerator and palette row were dead (no registered handler).
  useKeymapAction("new-worktree", () => {
    const slug = activeProjectSlug();
    if (slug) setCreateModalSlug(slug);
  });

  // Persist width back to `config.toml` exactly once per drag (on pointer-up
  // via `ResizeHandle.onCommit`). Skip any write that would echo the value we
  // just hydrated from disk, or repeat the last-persisted value.
  const commitWidth = (px: number) => {
    if (lastPersisted === undefined || lastPersisted === px) return;
    lastPersisted = px;
    void invoke<number>("config_set_sidebar_width", { width: px }).catch(() => {
      /* log-only */
    });
  };

  // Active project resolved from the top-bar tab. Both expanded and
  // collapsed views scope to this — the project-card chrome is gone from
  // the sidebar, so the tab at the top is the sole project identifier.
  const activeProject = createMemo(() =>
    projectStore.items.find((p) => p.slug === activeProjectSlug()),
  );

  // Fetch worktrees for the active project when collapsed so the mini-view
  // has data. When expanded, ProjectSection mounts its own resource.
  createEffect(() => {
    if (!collapsed()) return;
    const p = activeProject();
    if (p) void refreshWorktreeList(p.slug);
  });

  const renderedWidth = createMemo(() => (collapsed() ? SIDEBAR_COLLAPSED_PX : width()));

  return (
    <Show when={!sidebarHidden()}>
      <aside
        class={`relative flex shrink-0 flex-col overflow-hidden bg-background text-xs text-muted-foreground${
          dragging() ? "" : " transition-[width] duration-100"
        }`}
        style={{ width: `${renderedWidth()}px` }}
      >
        {/* ---- Collapsed mini-view ------------------------------------------------ */}
        {/* Shows the same three-icon status counter as the top-right harness     */}
        {/* widget, scoped per worktree. Icons are coloured when count > 0 and    */}
        {/* dimmed to foreground-dim when 0 — identical semantics to the global widget */}
        {/* so users build one visual vocabulary across the whole UI.             */}
        <Show when={collapsed()}>
          <Scrollable class="flex flex-col py-1">
            <Show when={activeProject()}>
              {(project) => {
                const wts = createMemo(() => worktreesByProject()[project().slug] ?? []);
                const allCounts = createMemo(() => harnessCountsForProject(project().slug));
                const isAllActiveMini = createMemo(
                  () =>
                    (activeWorktreeStore.byProject[project().slug] ?? ALL_WORKTREES_SCOPE).mode ===
                    "all",
                );
                return (
                  <>
                    <button
                      type="button"
                      class="flex w-full items-center justify-center gap-0.5 rounded px-0.5 py-1.5 hover:bg-hover"
                      classList={{ "sidebar-row-active": isAllActiveMini() }}
                      aria-current={isAllActiveMini() ? "true" : undefined}
                      title={`All terminals — ${allCounts().active} active · ${allCounts().waiting} waiting · ${allCounts().idle} idle`}
                      onClick={() => setActiveWorktreeAll(project().slug)}
                    >
                      <GridEqualIcon
                        class="size-3"
                        classList={{
                          "text-foreground": isAllActiveMini(),
                          "text-foreground-dim": !isAllActiveMini(),
                        }}
                      />
                    </button>
                    <For each={wts()}>
                      {(wt) => {
                        const counts = createMemo(() => harnessCountsForWorktree(wt.path));

                        const isActiveWt = createMemo(() => {
                          const s =
                            activeWorktreeStore.byProject[project().slug] ?? ALL_WORKTREES_SCOPE;
                          return s.mode === "worktree" && s.path === wt.path;
                        });

                        const wtName = createMemo(() => {
                          const parts = wt.path.split("/");
                          return parts[parts.length - 1] ?? wt.path;
                        });

                        return (
                          <button
                            type="button"
                            class="flex w-full items-center justify-center gap-0.5 rounded px-0.5 py-1.5 hover:bg-hover"
                            classList={{ "sidebar-row-active": isActiveWt() }}
                            aria-current={isActiveWt() ? "true" : undefined}
                            title={`${wtName()} — ${counts().active} active · ${counts().waiting} waiting · ${counts().idle} idle`}
                            onClick={() => setActiveWorktree(project().slug, wt.path)}
                          >
                            {/* Active — spinning loader, emerald when > 0 */}
                            <span
                              class="flex items-center"
                              classList={{
                                "text-success": counts().active > 0,
                                "text-foreground-dim": counts().active === 0,
                              }}
                            >
                              <LoaderIcon
                                class="size-2.5"
                                classList={{ "animate-spin": counts().active > 0 }}
                              />
                            </span>
                            {/* Waiting — alert circle, amber when > 0 */}
                            <span
                              class="flex items-center"
                              classList={{
                                "text-warning": counts().waiting > 0,
                                "text-foreground-dim": counts().waiting === 0,
                              }}
                            >
                              <AlertCircleIcon class="size-2.5" />
                            </span>
                            {/* Idle — check, zinc when > 0 */}
                            <span
                              class="flex items-center"
                              classList={{
                                "text-muted-foreground": counts().idle > 0,
                                "text-foreground-dim": counts().idle === 0,
                              }}
                            >
                              <CheckIcon class="size-2.5" />
                            </span>
                          </button>
                        );
                      }}
                    </For>
                  </>
                );
              }}
            </Show>
          </Scrollable>
        </Show>

        <Show when={!collapsed()}>
          {/* Search + add row */}
          <div class="flex shrink-0 items-center gap-1 px-2 py-2">
            <input
              type="search"
              class="h-7 min-w-0 flex-1 rounded bg-selected px-2 text-[11px] text-foreground placeholder:text-foreground-dim focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="Filter worktrees…"
              value={worktreeFilter()}
              onInput={(e) => setWorktreeFilter(e.currentTarget.value)}
              aria-label="Filter worktrees"
            />
            <button
              type="button"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-selected text-base leading-none text-muted-foreground transition-all duration-100 hover:bg-hover hover:text-foreground active:scale-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100"
              title={activeProjectSlug() ? "New worktree" : "Select a project first"}
              disabled={!activeProjectSlug()}
              onClick={() => setCreateModalSlug(activeProjectSlug() ?? null)}
            >
              +
            </button>
          </div>
          <Scrollable class="min-h-0 flex-1 p-2">
            <Show
              keyed
              when={activeProject()}
              fallback={<p class="px-2 text-foreground-dim">No projects registered yet.</p>}
            >
              {(project) => (
                <ProjectSection
                  project={project}
                  worktreeFilter={worktreeFilter()}
                  createOpen={createModalSlug() === project.slug}
                  onCreateClose={() => setCreateModalSlug(null)}
                />
              )}
            </Show>
          </Scrollable>
          <ResizeHandle
            getWidth={() => width()}
            onChange={(next) => setWidth(next)}
            onCommit={commitWidth}
            onDragChange={setDragging}
          />
        </Show>
      </aside>
    </Show>
  );
};

export default Sidebar;
