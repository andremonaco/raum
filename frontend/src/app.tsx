import { Show, createResource, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { TopRow } from "./components/top-row";
import { Sidebar } from "./components/sidebar";
import { TerminalGrid } from "./components/terminal-grid";
import { OnboardingWizard } from "./components/onboarding-wizard";
import { SpotlightDock } from "./components/spotlight-dock";
import { Toaster } from "./components/ui/sonner";
import { KeymapProvider, useKeymapAction } from "./lib/keymapContext";
import {
  markActiveLayoutHydrated,
  openActiveLayoutSaveGate,
  setRuntimeLayout,
  type ActiveLayoutState,
  type CellKind,
} from "./stores/runtimeLayoutStore";
import { installQuitFlush } from "./lib/quitFlush";
import { notifyBannerEnabled, startNotificationCenter } from "./lib/notificationCenter";
import { installGlobalContextMenuSuppressor } from "./lib/suppressContextMenu";
import { installDevtoolsShortcut } from "./lib/devtoolsShortcut";
import { loadThemeFromConfig } from "./lib/theme/themeController";
import { initHomeDir } from "./lib/pathDisplay";
import { installFileDrop } from "./lib/fileDrop";
import { installPaneFocusAcknowledger } from "./lib/paneFocusAcknowledger";
import { installWebviewHealth } from "./lib/webviewHealth";
import { installBackgroundRendererDemotion } from "./lib/rendererScheduler";
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
 *  same release. Honours `notifyBannerEnabled` so a user who has chosen
 *  silent-with-badge isn't interrupted. Swallows all errors — a missing
 *  network must not bubble out of the periodic timer. */
async function runBackgroundUpdateCheck(lastNotified: { version: string | null }): Promise<void> {
  try {
    const update = await checkForUpdate();
    if (!update) return;
    if (lastNotified.version === update.version) return;
    lastNotified.version = update.version;
    if (notifyBannerEnabled()) {
      try {
        await invoke("notifications_send", {
          args: {
            title: `raum update available: ${update.version}`,
            body: "Open Settings → Updates to download and install.",
            sessionId: null,
          },
        });
      } catch (e) {
        console.warn("notifications_send (update) failed", e);
      }
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

/** Bound the `active_layout_get` IPC call so a wedged backend (a lock held by
 *  a stalled command, a dropped IPC reply) can't leave hydration awaiting
 *  forever — which would keep the save gate closed and silently park EVERY
 *  layout mutation for the whole session. On timeout we open the gate (so this
 *  session's saves still flush) but deliberately do NOT mark hydration
 *  complete, so the empty-save guard in `runtimeLayoutStore` still protects a
 *  layout we never managed to read. */
const ACTIVE_LAYOUT_GET_TIMEOUT_MS = 4000;

const HYDRATE_TIMEOUT = Symbol("active-layout-get-timeout");

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
    const saved = await Promise.race([
      invoke<ActiveLayoutState>("active_layout_get"),
      new Promise<typeof HYDRATE_TIMEOUT>((resolve) =>
        setTimeout(() => resolve(HYDRATE_TIMEOUT), ACTIVE_LAYOUT_GET_TIMEOUT_MS),
      ),
    ]);
    if (saved === HYDRATE_TIMEOUT) {
      console.warn("active_layout_get timed out; skipping layout hydration this launch");
      return;
    }

    // A real layout (even an empty one) has now loaded — empty saves from here
    // on are legitimate. The destructive-clobber guard stays armed on the
    // failure paths below where this is never reached.
    markActiveLayoutHydrated();

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
    // Non-Tauri environment (browser dev), missing file, or a corrupt/
    // unparsable active-layout.toml whose `active_layout_get` rejected.
    // We deliberately leave `markActiveLayoutHydrated()` UNCALLED here: the
    // empty-save guard then refuses to overwrite a layout we failed to read
    // (do-not-overwrite on read failure), so a recoverable-by-hand corrupt
    // file isn't clobbered with `cells: []` by a stray boot save. The backend
    // read path quarantines the bad file separately (Contract 5).
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
    // Answer the backend's focus-gated liveness pings so a webview whose
    // WebContent process died during screen lock gets auto-reloaded
    // instead of staying black until the app is restarted.
    let stopWebviewHealth: (() => void) | undefined;
    void installWebviewHealth()
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        stopWebviewHealth = unlisten;
      })
      .catch((e) => console.warn("installWebviewHealth failed", e));
    // Shed WebGL contexts while the page is hidden (screen lock) to make
    // that WebContent kill less likely in the first place.
    const stopBackgroundDemotion = installBackgroundRendererDemotion();
    const stopShellContextPoller = startShellContextPoller();
    installPaneFocusAcknowledger();
    // Contract 1 (quit-flush): listen for the backend's `app-will-quit` and
    // flush every debounced writer (layout + terminal snapshots) before the
    // process exits, so a quit landing inside the 500 ms save debounce doesn't
    // lose the last layout mutation.
    let stopQuitFlush: (() => void) | undefined;
    void installQuitFlush()
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        stopQuitFlush = unlisten;
      })
      .catch((e) => console.warn("installQuitFlush failed", e));
    onCleanup(() => {
      disposed = true;
      stopFileDrop?.();
      stopWebviewHealth?.();
      stopBackgroundDemotion();
      stopShellContextPoller();
      stopQuitFlush?.();
    });
  });

  // §13.2 — mount the onboarding wizard on first launch (config.onboarded =
  // false) and dismiss it when the user finishes or skips. We treat any
  // `config_get` error as "already onboarded" so a test environment without
  // a Tauri host doesn't trap the UI behind the wizard.
  const [dismissed, setDismissed] = createSignal(false);
  const [cfg] = createResource<RaumConfigSnapshot>(async () => {
    // Read the config, but treat its failure as orthogonal to layout
    // hydration. `config_get` rejects whenever config.toml fails to parse or
    // the config mutex is poisoned (both plausible after a hard reboot), yet
    // `active_layout_get` is an independent command — coupling them meant a bad
    // config skipped hydration entirely and then let an early empty save
    // clobber the on-disk layout. Hydrate UNCONDITIONALLY below so the saved
    // cells are always read (and the save gate opened by hydration's `finally`)
    // regardless of whether the config read succeeded.
    let c: RaumConfigSnapshot = { onboarded: true };
    try {
      c = await invoke<RaumConfigSnapshot>("config_get");
    } catch (e) {
      // No Tauri host (browser dev / vitest) or a corrupt/poisoned config —
      // fall back to the onboarded default so the wizard isn't shown, but do
      // NOT open the save gate here: hydrateActiveLayout owns the gate and
      // opening it without first reading the layout is exactly the clobber we
      // are fixing.
      console.warn("config_get failed; continuing with defaults", e);
    }
    await hydrateActiveLayout();
    void prewarmAllWorktrees();
    void scheduleBackgroundUpdateCheck(c);
    return c;
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
