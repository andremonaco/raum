import { Show, createResource, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { TopRow } from "./components/top-row";
import { Sidebar } from "./components/sidebar";
import { TerminalGrid } from "./components/terminal-grid";
import { OnboardingWizard } from "./components/onboarding-wizard";
import { SpotlightDock } from "./components/spotlight-dock";
import { Toaster } from "./components/ui/sonner";
import { KeymapProvider, useKeymapAction } from "./lib/keymapContext";
import {
  openActiveLayoutSaveGate,
  setRuntimeLayout,
  type ActiveLayoutState,
  type CellKind,
} from "./stores/runtimeLayoutStore";
import { startNotificationCenter } from "./lib/notificationCenter";
import { installGlobalContextMenuSuppressor } from "./lib/suppressContextMenu";
import { installDevtoolsShortcut } from "./lib/devtoolsShortcut";
import { loadThemeFromConfig } from "./lib/theme/themeController";
import { initHomeDir } from "./lib/pathDisplay";
import { installFileDrop } from "./lib/fileDrop";
import { previewOnboarding, setPreviewOnboarding } from "./lib/devOnboardingPreview";
import { startShellContextPoller } from "./lib/shellContextPoller";
import { hydrateActiveWorktreeScopes, prewarmAllWorktrees } from "./stores/worktreeStore";
import { setActiveProjectSlug } from "./stores/projectStore";
import "overlayscrollbars/overlayscrollbars.css";

interface RaumConfigSnapshot {
  onboarded?: boolean;
  updater?: {
    check_on_launch?: boolean;
  };
}

/** 5 hours between background update polls. Long enough to stay quiet on
 *  the IPC bus and avoid rate-limiting GitHub, short enough that a machine
 *  left open overnight picks up a fresh release by morning. */
const UPDATE_POLL_INTERVAL_MS = 5 * 60 * 60 * 1000;

/** Startup grace period before the first check so it doesn't compete with
 *  tmux hydration and initial pane spawns over the Tauri IPC bus. */
const UPDATE_STARTUP_DELAY_MS = 10_000;

/** Run one updater check. Surfaces an OS notification only when the
 *  reported version differs from the one we last notified about, so a user
 *  who dismisses a notification isn't re-pinged every poll cycle for the
 *  same release. Swallows all errors — a missing network must not bubble
 *  out of the periodic timer. */
async function runBackgroundUpdateCheck(lastNotified: { version: string | null }): Promise<void> {
  try {
    const update = await checkForUpdate();
    if (!update) return;
    if (lastNotified.version === update.version) return;
    lastNotified.version = update.version;
    try {
      if (await isPermissionGranted()) {
        sendNotification({
          title: `raum update available: ${update.version}`,
          body: "Open Settings → Updates to download and install.",
        });
      }
    } catch {
      /* notification plugin unavailable — silently skip */
    }
    console.info(`raum: update ${update.version} available`);
  } catch (e) {
    console.warn("background update check failed", e);
  }
}

/** Run a background updater check after startup (when the user has opted
 *  in) and repeat every 5 hours for the life of the process. The Settings
 *  → Updates pane remains the canonical install surface; this just
 *  nudges users when a release drops while the app is running. */
async function scheduleBackgroundUpdateCheck(snapshot: RaumConfigSnapshot): Promise<void> {
  if (import.meta.env.DEV) return;
  if (snapshot.updater?.check_on_launch === false) return;

  await new Promise((resolve) => setTimeout(resolve, UPDATE_STARTUP_DELAY_MS));

  const lastNotified: { version: string | null } = { version: null };
  await runBackgroundUpdateCheck(lastNotified);
  setInterval(() => {
    void runBackgroundUpdateCheck(lastNotified);
  }, UPDATE_POLL_INTERVAL_MS);
}

/** Rehydrate the runtime grid from the last-saved `active-layout.toml`.
 *
 *  Persisted `session_id`s are passed through verbatim — `TerminalPane`
 *  attempts `terminal_reattach(session_id, …)` on mount and surfaces an
 *  explicit recovery error if neither tmux nor provider replay is available.
 *  The previous
 *  implementation cross-referenced `terminal_list()` here to strip dead
 *  ids, but that registry is EMPTY on fresh app boot (no panes have
 *  spawned yet), so it filtered out EVERY persisted id and forced every
 *  pane to spawn fresh — which is exactly how we ended up with hundreds
 *  of dangling tmux sessions. The authoritative live-check now happens
 *  inside `terminal_reattach` where `tmux has-session` is the source of
 *  truth. No-ops when no snapshot exists. */
async function hydrateActiveLayout(): Promise<void> {
  try {
    const saved = await invoke<ActiveLayoutState>("active_layout_get");

    // Restore the per-project sidebar scope FIRST, before any cell-level
    // setRuntimeLayout work. The grid's pruning pass keys on
    // `activeWorktreeStore.byProject`, so hydrating those entries here
    // means the very first render already shows the worktree-scoped view
    // the user had open at shutdown — without this, every project would
    // briefly fall back to the cross-worktree "all" aggregate before the
    // user clicked into their pinned worktree row again.
    if (saved.worktree_scopes) hydrateActiveWorktreeScopes(saved.worktree_scopes);
    // Restore the previously-active project tab. Set this even when the
    // saved layout has no cells: the user may have closed the app on an
    // empty project and we still want that project preselected. The
    // project-list reconcile in `setProjects` keeps this slug set as long
    // as it still exists on disk.
    if (saved.project_slug) setActiveProjectSlug(saved.project_slug);

    if (!saved.cells || saved.cells.length === 0) return;

    const cells = saved.cells.map((c) => ({
      id: c.id,
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      kind: c.kind as CellKind,
      title: c.title,
      projectSlug: c.project_slug,
      worktreeId: c.worktree_id,
      activeTabId: c.active_tab_id,
      tabs: c.tabs.map((t) => ({
        id: t.id,
        sessionId: t.session_id,
        label: t.label,
        projectSlug: t.project_slug,
        worktreeId: t.worktree_id,
      })),
      minimized: c.minimized === true,
    }));

    setRuntimeLayout(cells);
  } catch {
    // Non-Tauri environment (browser dev) or missing file — silently skip.
  } finally {
    // Open the persistence gate exactly once, after hydration has either
    // restored cells or confirmed there were none. Any save scheduled by
    // the project-list refresh that races us at startup has been parked
    // until now — without this gate, that early save could overwrite the
    // on-disk layout with `cells: []` before we read it back, leaving the
    // grid empty on the next launch with every live session adrift in the
    // dock as an orphan.
    openActiveLayoutSaveGate();
  }
}

/** Registers app-root keymap handlers that don't live on any single
 *  feature component. Must be rendered inside `KeymapProvider`. */
const RootShortcuts: Component = () => {
  useKeymapAction("reload", () => {
    window.location.reload();
  });
  return null;
};

const App: Component = () => {
  onMount(() => {
    void startNotificationCenter().catch((e) => console.warn("startNotificationCenter failed", e));
    installGlobalContextMenuSuppressor();
    installDevtoolsShortcut();
    void loadThemeFromConfig().catch((e) => console.warn("loadThemeFromConfig failed", e));
    void initHomeDir();
    let disposed = false;
    let stopFileDrop: (() => void) | undefined;
    void installFileDrop()
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        stopFileDrop = unlisten;
      })
      .catch((e) => console.warn("installFileDrop failed", e));
    const stopShellContextPoller = startShellContextPoller();
    onCleanup(() => {
      disposed = true;
      stopFileDrop?.();
      stopShellContextPoller();
    });
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
      void prewarmAllWorktrees();
      void scheduleBackgroundUpdateCheck(c);
      return c;
    } catch {
      // No Tauri host (browser dev / vitest) — there is no layout to read,
      // so unblock the save gate so future saves can proceed normally.
      openActiveLayoutSaveGate();
      return { onboarded: true };
    }
  });
  const showWizard = (): boolean => {
    if (previewOnboarding()) return true;
    if (dismissed()) return false;
    const c = cfg();
    if (!c) return false;
    return c.onboarded !== true;
  };

  return (
    <KeymapProvider>
      <RootShortcuts />
      <div class="flex h-full w-full flex-col text-foreground font-mono">
        <TopRow />
        <div class="flex flex-1 min-h-0">
          <Sidebar />
          <main class="relative flex-1 min-w-0 overflow-hidden">
            <TerminalGrid />
          </main>
        </div>
        <Show when={showWizard()}>
          <OnboardingWizard
            onDone={() => {
              setDismissed(true);
              setPreviewOnboarding(false);
            }}
          />
        </Show>
        <SpotlightDock />
        <Toaster />
      </div>
    </KeymapProvider>
  );
};

export default App;
