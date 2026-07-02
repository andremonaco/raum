import { Show, createResource, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "solid-sonner";
import { TopRow } from "./components/top-row";
import { Sidebar } from "./components/sidebar";
import { TerminalGrid } from "./components/terminal-grid";
import { OnboardingWizard } from "./components/onboarding-wizard";
import { SpotlightDock } from "./components/spotlight-dock";
import { Toaster } from "./components/ui/sonner";
import { KeymapProvider, useKeymapAction } from "./lib/keymapContext";
import {
  markActiveLayoutHydrated,
  markActiveLayoutHydrationSettled,
  openActiveLayoutSaveGate,
  setRuntimeLayout,
  type ActiveLayoutState,
  type CellKind,
} from "./stores/runtimeLayoutStore";
import type { TerminalListItem } from "./stores/terminalStore";
import { installQuitFlush } from "./lib/quitFlush";
import { startNotificationCenter } from "./lib/notificationCenter";
import { runUpdateCheck } from "./lib/updateNotifier";
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
import {
  hydrateActiveWorktreeScopes,
  prewarmAllWorktrees,
  resyncStatusSubscriptions,
} from "./stores/worktreeStore";
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

/** Run a background updater check after startup (when the user has opted
 *  in) and repeat every 5 hours for the life of the process. Surfaces a
 *  persistent in-app toast (see `updateNotifier`) rather than an OS banner,
 *  so the nudge is present whenever the user looks at the window. The
 *  Settings → Updates pane remains the canonical install surface. */
async function scheduleBackgroundUpdateCheck(snapshot: RaumConfigSnapshot): Promise<void> {
  if (import.meta.env.DEV) return;
  if (snapshot.updater?.check_on_launch === false) return;

  await new Promise((resolve) => setTimeout(resolve, UPDATE_STARTUP_DELAY_MS));

  await runUpdateCheck({ interactive: false });
  setInterval(() => {
    void runUpdateCheck({ interactive: false });
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
 *  truth. No-ops when no snapshot exists.
 *
 *  Returns the set of `session_id`s the saved layout placed into the grid (so
 *  the boot recovery toast can tell which live tmux sessions are *extra* — i.e.
 *  recovered orphans not in any cell), or `null` when hydration didn't resolve
 *  to a real layout (timeout / read failure / non-Tauri env) and a count would
 *  be meaningless. An empty set means "hydration succeeded, layout had no
 *  cells" — distinct from `null`. */
async function hydrateActiveLayout(): Promise<Set<string> | null> {
  try {
    const saved = await Promise.race([
      invoke<ActiveLayoutState & { quarantined?: boolean }>("active_layout_get"),
      new Promise<typeof HYDRATE_TIMEOUT>((resolve) =>
        setTimeout(() => resolve(HYDRATE_TIMEOUT), ACTIVE_LAYOUT_GET_TIMEOUT_MS),
      ),
    ]);
    if (saved === HYDRATE_TIMEOUT) {
      console.warn("active_layout_get timed out; skipping layout hydration this launch");
      return null;
    }

    // Surface a corrupt-and-quarantined active-layout.toml HERE, on the success
    // path: the backend degrades a corrupt file to the default and reports it
    // via `quarantined` rather than rejecting (which would clobber the
    // recoverable file). So a vanished layout reads as a recoverable hiccup,
    // not silent data loss. The backend owns the `<path>.bad-<stamp>` rename
    // and doesn't hand the name back over IPC, so the copy stays honest about
    // that rather than inventing a path.
    if (saved.quarantined) {
      toast("Saved layout couldn't be read", {
        description:
          "It was set aside so it's recoverable, and raum started with a fresh grid. " +
          "Your tmux sessions are safe — recovered ones appear in the dock.",
      });
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

    if (!saved.cells || saved.cells.length === 0) return new Set<string>();

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

    // Session ids the saved layout actually placed into the grid. The boot
    // recovery toast diffs this against the live `terminal_list` to count
    // sessions that survived but landed in the dock as orphans.
    const placed = new Set<string>();
    for (const c of cells) {
      for (const t of c.tabs) {
        if (t.sessionId) placed.add(t.sessionId);
      }
    }
    return placed;
  } catch {
    // Genuine IPC failure: non-Tauri environment (browser dev) or a hard
    // backend error — NOT a corrupt file (the backend degrades corruption to
    // a default + `quarantined` flag on the success path above, so it never
    // rejects here). No toast: there's no set-aside file to report, and
    // firing one here would be a false signal every browser-dev launch.
    //
    // We deliberately leave `markActiveLayoutHydrated()` UNCALLED: the
    // empty-save guard then refuses to overwrite a layout we failed to read
    // (do-not-overwrite on read failure), so nothing gets clobbered with
    // `cells: []` by a stray boot save.
    return null;
  } finally {
    // Open the persistence gate exactly once, after hydration has either
    // restored cells or confirmed there were none. Any save scheduled by
    // the project-list refresh that races us at startup has been parked
    // until now — without this gate, that early save could overwrite the
    // on-disk layout with `cells: []` before we read it back, leaving the
    // grid empty on the next launch with every live session adrift in the
    // dock as an orphan.
    openActiveLayoutSaveGate();
    // Mark the hydration ATTEMPT finished on every exit (success, empty,
    // timeout, corrupt) so the grid's loading skeleton always resolves — to
    // the saved layout, the first-run CTA, or the spawn picker — instead of
    // hanging on a faint skeleton forever after a failed/empty read. Distinct
    // from markActiveLayoutHydrated(), which stays uncalled on failures to
    // keep the empty-save anti-clobber guard armed.
    markActiveLayoutHydrationSettled();
  }
}

/** Pure count of recovered orphan sessions: alive (non-dead) live sessions the
 *  just-hydrated layout did NOT place into a cell. Exported for unit tests so
 *  the diff rule lives somewhere exercisable without a Tauri host. */
export function countRecoveredSessions(
  placed: ReadonlySet<string>,
  live: readonly Pick<TerminalListItem, "session_id" | "dead">[],
): number {
  let recovered = 0;
  for (const item of live) {
    if (item.dead === true) continue;
    if (placed.has(item.session_id)) continue;
    recovered += 1;
  }
  return recovered;
}

/** One-time boot toast that tells the user how many live tmux sessions
 *  survived a close/reboot but did NOT land back in the grid — i.e. recovered
 *  orphans now waiting in the dock. Without this the survivors appear silently
 *  in the dock tray and a user who doesn't scan the strip assumes they were
 *  lost.
 *
 *  `placed` is the set of session ids the just-hydrated layout mounted into
 *  cells (or `null` when hydration didn't resolve — see `hydrateActiveLayout`).
 *  We diff that against the authoritative live list from `terminal_list`:
 *  every alive (non-dead) session NOT in `placed` is a recovered orphan. The
 *  Rust boot reconcile (`reconcile_inner`) has already adopted these into the
 *  registry by the time we read, so `terminal_list` is the reliable source —
 *  the frontend's own later `terminal_reconcile` call usually returns `[]`.
 *
 *  Best-effort and silent on any failure: a missing Tauri host (tests / browser
 *  dev) or an empty/clean recovery simply shows nothing. */
async function notifyRecoveredSessions(placed: Set<string> | null): Promise<void> {
  // `null` means hydration never resolved to a real layout (timeout / read
  // failure). We can't tell "recovered" from "expected" without a baseline, so
  // stay quiet rather than mislabel every live session as an orphan.
  if (placed === null) return;
  let live: TerminalListItem[];
  try {
    live = await invoke<TerminalListItem[]>("terminal_list");
  } catch {
    // No Tauri host or an older backend — nothing to report.
    return;
  }
  const recovered = countRecoveredSessions(placed, live);
  if (recovered === 0) return;
  const noun = recovered === 1 ? "session" : "sessions";
  // The count spans ALL projects (terminal_list is global), but each project's
  // dock only shows its OWN orphans — so don't claim "N waiting in the dock"
  // when the user may be on a project whose dock shows 0. Acknowledge that
  // some may live under other projects.
  toast(`Recovered ${recovered} ${noun}`, {
    description:
      recovered === 1
        ? "It's waiting in the dock — if it isn't under this project, switch projects to find it. Click its chip to place it back in the grid."
        : "They're waiting in the dock, some possibly under other projects — switch projects to find them. Click a chip to place one back in the grid.",
  });
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
    // On window focus, re-push the worktree-status subscription set. The push
    // is declarative + idempotent, so this costs nothing when everything is
    // healthy, but it lets the backend detect and respawn any watch task that
    // died silently while the sidebar kept the same rows — the case where the
    // sidebar diffstat freezes with no refcount change to trigger a fresh push.
    let stopFocusResync: (() => void) | undefined;
    void Promise.resolve()
      .then(() =>
        getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          if (focused) resyncStatusSubscriptions();
        }),
      )
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        stopFocusResync = unlisten;
      })
      .catch((e) => console.warn("status subscription focus resync failed", e));
    onCleanup(() => {
      disposed = true;
      stopFileDrop?.();
      stopWebviewHealth?.();
      stopBackgroundDemotion();
      stopShellContextPoller();
      stopQuitFlush?.();
      stopFocusResync?.();
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
    const placed = await hydrateActiveLayout();
    // Fire-and-forget: the recovery toast must not gate the wizard/onboarding
    // resource resolving, and a slow `terminal_list` shouldn't delay first
    // paint. Errors are swallowed inside the helper.
    void notifyRecoveredSessions(placed);
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
