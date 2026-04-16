import { Show, createResource, createSignal, onMount, type Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { TopRow } from "./components/top-row";
import { Sidebar } from "./components/sidebar";
import { TerminalGrid } from "./components/terminal-grid";
import { OnboardingWizard } from "./components/onboarding-wizard";
import { SpotlightDock } from "./components/spotlight-dock";
import { KeymapProvider } from "./lib/keymapContext";
import { setRuntimeLayout, type ActiveLayoutState } from "./stores/runtimeLayoutStore";
import type { CellKind } from "./stores/layoutPresetStore";
import { startNotificationCenter } from "./lib/notificationCenter";

interface RaumConfigSnapshot {
  onboarded?: boolean;
}

interface TerminalListItem {
  session_id: string;
}

/** Rehydrate the runtime grid from the last-saved `state/active-layout.toml`.
 *  Cross-references live tmux sessions so dead session IDs are stripped (the
 *  pane reverts to "spawn" state naturally). No-ops when no snapshot exists. */
async function hydrateActiveLayout(): Promise<void> {
  try {
    const [saved, live] = await Promise.all([
      invoke<ActiveLayoutState>("active_layout_get"),
      invoke<TerminalListItem[]>("terminal_list"),
    ]);

    if (!saved.cells || saved.cells.length === 0) return;

    const liveIds = new Set(live.map((s) => s.session_id));

    const cells = saved.cells.map((c) => ({
      id: c.id,
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      kind: c.kind as CellKind,
      title: c.title,
      activeTabId: c.active_tab_id,
      tabs: c.tabs.map((t) => ({
        id: t.id,
        sessionId: t.session_id && liveIds.has(t.session_id) ? t.session_id : undefined,
      })),
    }));

    setRuntimeLayout(cells, saved.source_preset ?? null);
  } catch {
    // Non-Tauri environment (browser dev) or missing file — silently skip.
  }
}

const App: Component = () => {
  onMount(() => {
    void startNotificationCenter().catch((e) => console.warn("startNotificationCenter failed", e));
  });

  // §13.2 — mount the onboarding wizard on first launch (config.onboarded =
  // false) and dismiss it when the user finishes or skips. We treat any
  // `config_get` error as "already onboarded" so a test environment without
  // a Tauri host doesn't trap the UI behind the wizard.
  const [dismissed, setDismissed] = createSignal(false);
  const [cfg] = createResource<RaumConfigSnapshot>(async () => {
    try {
      const c = await invoke<RaumConfigSnapshot>("config_get");
      // Hydrate the grid after confirming we're inside a Tauri host.
      await hydrateActiveLayout();
      return c;
    } catch {
      return { onboarded: true };
    }
  });
  const showWizard = (): boolean => {
    if (dismissed()) return false;
    const c = cfg();
    if (!c) return false;
    return c.onboarded !== true;
  };

  return (
    <KeymapProvider>
      <div class="flex h-full w-full flex-col bg-background text-foreground font-mono">
        <TopRow />
        <div class="flex flex-1 min-h-0">
          <Sidebar />
          <main class="flex-1 min-w-0 overflow-hidden">
            <TerminalGrid />
          </main>
        </div>
        <Show when={showWizard()}>
          <OnboardingWizard onDone={() => setDismissed(true)} />
        </Show>
        <SpotlightDock />
      </div>
    </KeymapProvider>
  );
};

export default App;
