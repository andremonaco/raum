/**
 * §11 — frontend notification center.
 *
 * Subscribes to the `agent-state-changed` Tauri event (bridged from
 * raum-core's state machine by §7.8), filters on transitions to `waiting`,
 * coalesces rapid re-transitions with a 3s per-agent debounce (§11.2), and
 * dispatches three side effects:
 *
 *   1. An in-app toast via `solid-sonner` (mounted as `<Toaster />`
 *      from `components/ui/sonner.tsx`). Fires only when the OS
 *      notification path is unavailable (permission not granted, or the
 *      plugin itself is unreachable — e.g. unbundled `tauri dev` on
 *      macOS). When the OS path works it is authoritative; we don't
 *      stack a toast on top.
 *   2. An OS notification via `@tauri-apps/plugin-notification`. Fires
 *      regardless of window focus — if the user has enabled notifications
 *      in settings they should see every event. Clicking the notification
 *      focuses the owning pane. Permission is requested on first launch;
 *      on denial we set a one-time flag in
 *      `Config.notifications.notifications_hint_shown` (§11.4).
 *   3. An optional sound played via the backend `notifications_play_sound`
 *      command, which delegates to the OS event-sound player (afplay /
 *      canberra-gtk-play). Path from `Config.notifications.sound` (§11.5).
 *      We don't use the webview's `<audio>` element because WKWebView
 *      registers it with macOS's Now Playing session and pauses Spotify.
 *   4. A dock/taskbar badge counter reflecting the cross-project count
 *      of agents currently in `waiting` (§11.3). The counter is driven
 *      from the store; callers only need to invoke
 *      `startNotificationCenter`.
 *
 * Clicking "Open" on a toast (or an OS notification) focuses the
 * owning pane via the `terminal-focus-requested` CustomEvent.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onAction, sendNotification } from "@tauri-apps/plugin-notification";
import { createEffect, createRoot, createSignal } from "solid-js";
import { toast } from "solid-sonner";

import { kindDisplayLabel } from "./agentKind";
import { unreadAgentCount } from "../stores/agentStore";
import type { AgentKind, AgentState, Reliability } from "../stores/agentStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentStateChangedPayload {
  session_id: { 0?: string } | string;
  harness: AgentKind;
  from: AgentState;
  to: AgentState;
  /**
   * Per-harness notification plan, Phase 1. Replaces the previous
   * boolean `via_silence_heuristic` flag on this payload. Optional for
   * backwards compatibility with any cached events emitted before the
   * transition lands, but the backend always writes it.
   */
  reliability?: Reliability;
}

/**
 * Backend emits this on `notification-event` whenever a harness reports a
 * permission-needed state. Some harnesses provide a reply token, others do
 * not; the notification UX is focus-only in both cases.
 */
interface NotificationEventPayload {
  harness: AgentKind;
  event: string;
  session_id?: string | null;
  request_id?: string | null;
  permission_key: string;
  payload?: Record<string, unknown> | null;
}

/** Per-agent notification metadata the caller can optionally supply. */
export interface NotificationContext {
  /** Display name for the originating project — rendered in the title. */
  projectName?: string;
  /** Display name for the worktree — rendered in the body. */
  worktreeName?: string;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Window in which a `notification-event` (PermissionRequest) and the
 * back-to-back `agent-state-changed` → `waiting` transition that follows
 * it are considered the same notification. The backend emits both in the
 * same loop iteration (`src-tauri/src/commands/agent.rs`), so without this
 * the user would hear two sounds and see two toasts for one event.
 * The badge / pending-permission counters update unconditionally; this
 * gate only affects sound and toast emission.
 */
export const NOTIFY_DEDUP_MS = 250;

// ---------------------------------------------------------------------------
// Reactive surface the UI can read
// ---------------------------------------------------------------------------

const [permissionState, setPermissionState] = createSignal<"granted" | "denied" | "unknown">(
  "unknown",
);
export { permissionState };

/**
 * The bundle id (macOS) or DBus service name (Linux) the OS attributes our
 * notifications to. On macOS dev builds this is `com.apple.Terminal` because
 * `notify_rust` masquerades as Terminal — the badge in the settings UI
 * surfaces this so the user knows which app's permission to toggle.
 */
const [notificationBundleId, setNotificationBundleId] = createSignal("");
export { notificationBundleId };

/**
 * True when running unbundled (`task dev`). On macOS this means notifications
 * fire as Terminal; on Linux there is no equivalent caveat so this is always
 * false.
 */
const [notificationDevMode, setNotificationDevMode] = createSignal(false);
export { notificationDevMode };

/**
 * Optional human-readable note returned by the backend, used for surface-level
 * caveats like the dev-mode "fires as Terminal" hint or the Linux missing-
 * daemon message.
 */
const [notificationStateNote, setNotificationStateNote] = createSignal<string | null>(null);
export { notificationStateNote };

/**
 * True when the OS notification path is definitively unusable — i.e. the user
 * has explicitly denied permission. `"unknown"` means the bundle has not yet
 * been registered with the OS notification center (first launch, no prior
 * `sendNotification` call); on macOS that is the state _before_ the first
 * permission prompt, not a rejection. We optimistically try the OS path in
 * that case so the very first real notification triggers the system prompt
 * and registers the bundle — otherwise we'd be stuck in the toast fallback
 * forever, because the plist entry never gets written without a send.
 */
export const osNotificationsUnavailable = (): boolean => permissionState() === "denied";

/** Whether to fire notifications when an agent needs input (`waiting`). */
const [notifyOnWaiting, setNotifyOnWaiting] = createSignal(true);
export { notifyOnWaiting };

/** Whether to fire notifications when an agent finishes (`completed` / `errored`). */
const [notifyOnDone, setNotifyOnDone] = createSignal(true);
export { notifyOnDone };

/**
 * Master delivery switch for OS notification banners. When `false`, every
 * dispatch path short-circuits before calling `sendNotification` and also
 * skips the in-app toast fallback — the user asked for a silent-with-badge
 * experience and a toast is still a visual interruption. The dock badge
 * is independent (driven by `badgeMode`) so counts keep updating.
 *
 * Explicit diagnostic sends (the Settings → "Send test" button) bypass
 * this gate: it's a one-shot "does the OS path work?" probe and must fire
 * regardless of the user's standing preference.
 */
const [notifyBannerEnabled, setNotifyBannerEnabled] = createSignal(true);
export { notifyBannerEnabled };

/**
 * §11.3 — dock/taskbar badge verbosity. Mirrors `raum_core::config::BadgeMode`
 * (serialised snake_case). Default matches the Rust default so a fresh
 * install gets "all unread" behavior before `config_get` completes.
 */
export type BadgeMode = "off" | "critical" | "all_unread";

const [badgeMode, setBadgeMode] = createSignal<BadgeMode>("all_unread");
export { badgeMode };

/**
 * Set of open permission keys for requests the user has yet to
 * answer. The size drives the "Critical" badge mode. Kept outside Solid's
 * reactive graph (plain `Set`) so module consumers and tests can mutate it
 * synchronously; the derived `pendingPermissionCount` signal is the
 * reactive surface.
 */
const pendingPermissionKeys = new Set<string>();
const pendingPermissionSessions = new Map<string, string>();
const [pendingPermissionCount, setPendingPermissionCount] = createSignal(0);
export { pendingPermissionCount };

function addPendingPermission(
  permissionKey: string,
  sessionId: string | null | undefined,
): boolean {
  if (!permissionKey) return false;
  if (pendingPermissionKeys.has(permissionKey)) return false;
  pendingPermissionKeys.add(permissionKey);
  if (sessionId) pendingPermissionSessions.set(permissionKey, sessionId);
  setPendingPermissionCount(pendingPermissionKeys.size);
  return true;
}

function clearPendingPermission(permissionKey: string): void {
  if (!pendingPermissionKeys.delete(permissionKey)) return;
  pendingPermissionSessions.delete(permissionKey);
  setPendingPermissionCount(pendingPermissionKeys.size);
}

function clearPendingPermissionsForSession(sessionId: string): void {
  let mutated = false;
  for (const [permissionKey, sid] of pendingPermissionSessions) {
    if (sid === sessionId) {
      pendingPermissionSessions.delete(permissionKey);
      pendingPermissionKeys.delete(permissionKey);
      mutated = true;
    }
  }
  if (mutated) setPendingPermissionCount(pendingPermissionKeys.size);
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/**
 * Timestamp (ms since epoch) of the last emitted sound/toast per session.
 * Consulted by `shouldDedupNotify` to suppress the second half of a
 * permission-event + waiting-transition pair. See {@link NOTIFY_DEDUP_MS}.
 */
const lastNotifyAt = new Map<string, number>();
const contextBySession = new Map<string, NotificationContext>();

function shouldDedupNotify(sessionId: string, now: number): boolean {
  const prev = lastNotifyAt.get(sessionId);
  if (prev !== undefined && now - prev < NOTIFY_DEDUP_MS) return true;
  lastNotifyAt.set(sessionId, now);
  return false;
}

/**
 * Register (or update) the human-readable context for a session. The title
 * and body of the OS notification are built from these strings. Callers are
 * expected to update this when a worktree is renamed or a project is
 * registered; we persist nothing.
 */
export function setNotificationContext(sessionId: string, ctx: NotificationContext): void {
  contextBySession.set(sessionId, ctx);
}

export function clearNotificationContext(sessionId: string): void {
  contextBySession.delete(sessionId);
  lastNotifyAt.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Permission handling (§11.4)
// ---------------------------------------------------------------------------

interface NotificationAuthorization {
  status: "granted" | "denied" | "unknown";
  bundle_id: string;
  is_dev_mode: boolean;
  note: string | null;
}

/**
 * Probe the actual OS authorization state via the Rust backend. The Tauri
 * notification plugin's desktop permission APIs are hard-coded to return
 * granted, so the backend checks the native UserNotifications API on macOS and
 * the session notification service on Linux instead. Updates the reactive
 * signals and returns the raw payload for callers that need the bundle/dev
 * fields.
 */
export async function refreshNotificationAuthorization(): Promise<NotificationAuthorization> {
  try {
    const auth = await invoke<NotificationAuthorization>("notifications_check_authorization");
    setPermissionState(auth.status);
    setNotificationBundleId(auth.bundle_id);
    setNotificationDevMode(auth.is_dev_mode);
    setNotificationStateNote(auth.note ?? null);
    return auth;
  } catch (e) {
    console.warn("notifications_check_authorization failed", e);
    setPermissionState("unknown");
    setNotificationBundleId("");
    setNotificationDevMode(false);
    setNotificationStateNote(null);
    return { status: "unknown", bundle_id: "", is_dev_mode: false, note: null };
  }
}

/**
 * Open the OS notification settings panel — the canonical place for the user
 * to toggle authorization. On macOS this lands on the Notifications pane in
 * System Settings; on Linux it tries the active desktop environment's control
 * panel. After the user returns, callers should re-invoke
 * [`refreshNotificationAuthorization`] to pick up the new state.
 */
export async function openNotificationSystemSettings(): Promise<void> {
  try {
    await invoke("notifications_open_system_settings");
  } catch (e) {
    console.warn("notifications_open_system_settings failed", e);
  }
}

/**
 * Best-effort first-launch initialiser. The plugin can no longer "request"
 * permission (its desktop impl is a no-op), so this just resolves the current
 * state. The actual macOS first-time prompt is triggered by the first real
 * `sendNotification` call — typically the user's "Send test" click.
 */
export async function ensureNotificationPermission(): Promise<"granted" | "denied" | "unknown"> {
  const auth = await refreshNotificationAuthorization();
  if (auth.status !== "granted") {
    try {
      await invoke("notifications_mark_hint_shown");
    } catch (e) {
      console.warn("notifications_mark_hint_shown failed", e);
    }
  }
  return auth.status;
}

// ---------------------------------------------------------------------------
// Dispatch helpers
// ---------------------------------------------------------------------------

function titleFor(ctx: NotificationContext | undefined, harness: AgentKind): string {
  void ctx;
  void harness;
  return "Interactive Question";
}

function bodyFor(
  ctx: NotificationContext | undefined,
  sessionId: string,
  harness: AgentKind,
): string {
  void ctx;
  void sessionId;
  return `${kindDisplayLabel(harness)} is asking for feedback.`;
}

async function playSound(path: string): Promise<void> {
  if (!path) return;
  try {
    await invoke("notifications_play_sound", { path });
  } catch (e) {
    console.warn("notifications_play_sound failed", path, e);
  }
}

/**
 * Play `path` once for the settings preview button. Bypasses the
 * focus / debounce gate so the user can audition a sound without an agent
 * actually transitioning to `waiting`.
 */
export async function previewSound(path: string): Promise<void> {
  if (!path) return;
  await playSound(path);
}

/**
 * Dispatch the "focus this session's pane" CustomEvent that `TerminalPane`
 * subscribes to. Shared by the toast "Open" action callbacks and the OS
 * notification action listener so both paths converge on the same behavior.
 */
function focusSession(sessionId: string): void {
  if (!sessionId) return;
  try {
    window.dispatchEvent(
      new CustomEvent("terminal-focus-requested", {
        detail: { sessionId },
      }),
    );
  } catch {
    /* non-DOM env */
  }
}

/**
 * Fire a test notification from the settings UI so the user can verify the
 * full notify path end-to-end. Always pushes both an in-app toast and an OS
 * notification — the OS attempt also doubles as the macOS first-time
 * permission probe, since `tauri-plugin-notification` no longer drives that
 * dialog separately. Re-reads the authorization state afterwards so the
 * badge reflects the user's choice immediately.
 */
export async function sendTestNotification(): Promise<void> {
  const title = "raum: test notification";
  const body = "If you see this, notifications are working.";
  void playWaitingSound();

  let osSent = false;
  if (osNotificationsAvailable()) {
    try {
      sendNotification({ title, body });
      osSent = true;
    } catch (e) {
      console.warn("sendTestNotification: sendNotification failed", e);
    }
  }

  // Toast is the fallback — only surface it when the OS path is known to be
  // unavailable (denied) or the send call threw.
  if (!osSent) {
    toast.success(title, { description: body });
  }

  // The first sendNotification on macOS may surface the OS authorization
  // prompt; re-probe so the badge picks up the new state without forcing the
  // user to reopen settings.
  await refreshNotificationAuthorization();
}

/**
 * True when the OS notification path is worth attempting. We try on both
 * `"granted"` and `"unknown"` — the latter is the pre-prompt state on macOS,
 * where the first `sendNotification` call can trigger the system permission
 * dialog. Treating `"unknown"` as "not available" would keep us locked in the
 * toast fallback forever, because the first real send is what lets macOS
 * resolve the app's notification authorization path.
 */
function osNotificationsAvailable(): boolean {
  return permissionState() !== "denied";
}

// Tracks whether the raum window is currently focused. Conservative default
// (true) avoids a spurious unfocused-toast race before the first isFocused()
// probe resolves in startNotificationCenter.
let _windowFocused = true;

async function startWindowFocusTracking(): Promise<() => void> {
  const win = getCurrentWindow();
  _windowFocused = await win.isFocused();
  const unBlur = await win.listen("blur", () => {
    _windowFocused = false;
  });
  const unFocus = await win.listen("focus", () => {
    _windowFocused = true;
    void refreshNotificationAuthorization();
  });
  return () => {
    unBlur();
    unFocus();
  };
}

async function readSoundPath(): Promise<string | undefined> {
  try {
    const cfg = await invoke<{ notifications?: { sound?: string | null } }>("config_get");
    const s = cfg.notifications?.sound;
    return s && s.length > 0 ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Read notification-related config fields and update the reactive signals. */
async function loadNotificationConfig(): Promise<void> {
  try {
    const cfg = await invoke<{
      notifications?: {
        notify_on_waiting?: boolean;
        notify_on_done?: boolean;
        notify_banner_enabled?: boolean;
        badge_mode?: BadgeMode;
      };
    }>("config_get");
    setNotifyOnWaiting(cfg.notifications?.notify_on_waiting ?? true);
    setNotifyOnDone(cfg.notifications?.notify_on_done ?? true);
    setNotifyBannerEnabled(cfg.notifications?.notify_banner_enabled ?? true);
    const mode = cfg.notifications?.badge_mode;
    if (mode === "off" || mode === "critical" || mode === "all_unread") {
      setBadgeMode(mode);
    }
  } catch {
    // Keep existing signal values; best-effort.
  }
}

/**
 * Re-read notification config from disk and refresh the reactive signals.
 * The settings modal calls this after the user saves a change so the rest
 * of the notification center reacts immediately without a full restart.
 */
export async function refreshNotificationConfig(): Promise<void> {
  await loadNotificationConfig();
}

/**
 * Play the configured waiting sound, if any. Shared by the waiting and
 * permission dispatchers so adding a sound to one path automatically
 * keeps them in sync.
 */
async function playWaitingSound(): Promise<void> {
  const soundPath = await readSoundPath();
  if (soundPath) void playSound(soundPath);
}

async function dispatchWaitingNotification(sessionId: string, harness: AgentKind): Promise<void> {
  if (!notifyOnWaiting()) return;
  if (shouldDedupNotify(sessionId, Date.now())) return;

  const ctx = contextBySession.get(sessionId);
  const title = titleFor(ctx, harness);
  const body = bodyFor(ctx, sessionId, harness);

  void playWaitingSound();

  // Banner master switch off → user opted into silent-with-badge. Skip both
  // the OS notification AND the toast fallback; the dock badge still ticks
  // via `handleAgentStateChanged`'s unread/pending counters.
  if (!notifyBannerEnabled()) return;

  // Toast is the fallback — fires only when the OS path is definitively
  // denied. On `"unknown"` we still attempt the OS path so the first send
  // triggers macOS's authorization prompt and registers the bundle. The
  // focus state of the window is intentionally NOT consulted: if the user
  // has enabled notifications they should fire regardless of which window
  // is foregrounded. The "Open" action fires the same
  // `terminal-focus-requested` CustomEvent that the OS-notification click
  // path uses.
  if (!osNotificationsAvailable()) {
    if (!_windowFocused) {
      toast(title, {
        description: body,
        action: { label: "Open", onClick: () => focusSession(sessionId) },
      });
    }
    return;
  }

  try {
    sendNotification({ title, body, extra: { sessionId } });
  } catch (e) {
    console.warn("sendNotification failed", e);
  }
}

async function dispatchDoneNotification(
  sessionId: string,
  harness: AgentKind,
  doneState: "completed" | "errored",
): Promise<void> {
  if (!notifyOnDone()) return;

  const ctx = contextBySession.get(sessionId);
  void ctx;
  const harnessName = kindDisplayLabel(harness);
  const title = doneState === "completed" ? "Finished" : "Error";
  const body =
    doneState === "completed"
      ? `${harnessName} finished successfully.`
      : `${harnessName} hit an error.`;

  const soundPath = await readSoundPath();
  if (soundPath) void playSound(soundPath);

  // Banner master switch off → silent-with-badge. Skip both the OS banner
  // and the toast fallback.
  if (!notifyBannerEnabled()) return;

  // Toast is the fallback when the OS path is denied; click → focuses the
  // pane. When the OS path is viable (granted or pre-prompt), fire the
  // system notification regardless of window focus — the user opted in
  // via the notification settings and we don't second-guess them.
  if (!osNotificationsAvailable()) {
    const toastKind = doneState === "completed" ? toast.success : toast.error;
    toastKind(title, {
      description: body,
      action: { label: "Open", onClick: () => focusSession(sessionId) },
    });
    return;
  }

  try {
    sendNotification({ title, body, extra: { sessionId } });
  } catch (e) {
    console.warn("sendNotification failed", e);
  }
}

// ---------------------------------------------------------------------------
// Event wiring (§11.1)
// ---------------------------------------------------------------------------

function sessionIdFromPayload(id: AgentStateChangedPayload["session_id"]): string {
  if (typeof id === "string") return id;
  if (typeof id === "object" && id && "0" in id && typeof id[0] === "string") {
    return id[0];
  }
  return "";
}

function handleAgentStateChanged(payload: AgentStateChangedPayload): void {
  const sessionId = sessionIdFromPayload(payload.session_id);
  if (!sessionId) return;

  // A session leaving `waiting` means any open permission requests it owned
  // have been resolved (possibly outside raum, e.g. answered in the TUI).
  // Drop them so the Critical badge count stays accurate.
  if (payload.from === "waiting" && payload.to !== "waiting") {
    clearPendingPermissionsForSession(sessionId);
  }

  if (payload.to === "completed" || payload.to === "errored") {
    void dispatchDoneNotification(sessionId, payload.harness, payload.to);
    return;
  }

  if (payload.to !== "waiting") return;

  // Fire immediately. The `NOTIFY_DEDUP_MS` guard inside
  // `dispatchWaitingNotification` keeps us from double-firing when a
  // PermissionRequest just ran `dispatchPermissionNotification` in the
  // same ~ms.
  void dispatchWaitingNotification(sessionId, payload.harness);
}

/**
 * Install the notification center. Returns a disposer that unregisters both
 * the `agent-state-changed` listener and the OS notification action handler.
 *
 * Callers should invoke this once at app start (after the initial config
 * hydration); repeated invocations install parallel listeners and waste IPC.
 */
export async function startNotificationCenter(): Promise<UnlistenFn> {
  await ensureNotificationPermission();
  await loadNotificationConfig();
  const disposeWindowFocus = await startWindowFocusTracking();

  const unlistenState = await listen<AgentStateChangedPayload>("agent-state-changed", (ev) => {
    handleAgentStateChanged(ev.payload);
  });
  const unlistenRemoved = await listen<{ session_id: string }>("agent-session-removed", (ev) => {
    const sessionId = ev.payload.session_id;
    if (!sessionId) return;
    clearPendingPermissionsForSession(sessionId);
  });

  // Permission-needed notifications are focus-only regardless of whether the
  // backend can technically reply to the harness.
  const unlistenPermission = await listen<NotificationEventPayload>("notification-event", (ev) => {
    void dispatchPermissionNotification(ev.payload);
  });

  // §11.6 — click-to-focus. Permission notifications are informational; the
  // user answers inside the harness after we focus the pane.
  const actionListener = await onAction((payload) => {
    const extra = payload.extra;
    const sessionId = typeof extra?.sessionId === "string" ? extra.sessionId : "";
    void invoke("notifications_focus_main").catch(() => {
      /* best-effort */
    });
    focusSession(sessionId);
  });

  // §11.3 — mode-aware dock/taskbar badge driver. Reads `badgeMode` +
  // `pendingPermissionCount` + `unreadAgentCount` so the badge stays in
  // sync with whichever verbosity level the user has picked.
  const disposeBadge = createRoot((dispose) => {
    createEffect(() => {
      const mode = badgeMode();
      if (mode === "off") {
        syncDockBadge(0);
      } else if (mode === "critical") {
        syncDockBadge(pendingPermissionCount());
      } else {
        syncDockBadge(unreadAgentCount());
      }
    });
    return dispose;
  });

  return () => {
    unlistenState();
    unlistenRemoved();
    unlistenPermission();
    actionListener.unregister();
    disposeBadge();
    disposeWindowFocus();
    lastNotifyAt.clear();
  };
}

/**
 * Surface a permission-request notification. The popup is focus-only: clicking
 * it brings the pane forward and the user answers inside the harness.
 */
async function dispatchPermissionNotification(payload: NotificationEventPayload): Promise<void> {
  if (!payload.permission_key) return;
  const isNew = addPendingPermission(payload.permission_key, payload.session_id ?? null);
  // Badge/pending counters are updated above regardless. The rest of
  // this function only runs when the permission key is new AND the
  // session hasn't already notified within `NOTIFY_DEDUP_MS` (prevents
  // the back-to-back `notification-event` + `agent-state-changed` pair
  // from double-firing sound + toast).
  if (!isNew) return;
  const sessionId = payload.session_id ?? "";
  if (sessionId && shouldDedupNotify(sessionId, Date.now())) return;

  const ctx = payload.session_id ? contextBySession.get(payload.session_id) : undefined;
  void ctx;
  const title = "Permission requested";
  const summary = permissionSummaryFor(payload);

  void playWaitingSound();

  // Banner master switch off → silent-with-badge. The pending-permission
  // counter already incremented above (drives the dock badge in Critical
  // mode), so the user still notices; we just don't interrupt with a
  // banner or toast.
  if (!notifyBannerEnabled()) return;

  // Auto-close uses the Toaster's default duration; the dock badge and OS
  // notification keep the request visible after the toast fades. A manual
  // dismiss (close button or swipe) is treated as "ignore this request"
  // and aborts the session — sonner routes that through `onDismiss`,
  // while the timer path fires `onAutoClose`, so auto-hiding the toast
  // does not abort.
  // When raum is focused the pane bump handles the "look here" signal;
  // the toast is reserved for the unfocused / background case.
  if (!_windowFocused) {
    toast.warning(title, {
      description: summary,
      action: { label: "Open", onClick: () => focusSession(sessionId) },
      onDismiss: () => {
        if (!sessionId) return;
        void invoke("abort_session", { sessionId }).catch((e) => {
          console.warn("abort_session from toast dismiss failed", e);
        });
      },
    });
  }

  if (osNotificationsAvailable()) {
    try {
      sendNotification({
        title,
        body: summary,
        extra: { sessionId },
      } as unknown as Parameters<typeof sendNotification>[0]);
    } catch (e) {
      console.warn("sendNotification (permission) failed", e);
    }
  }
}

function permissionSummaryFor(payload: NotificationEventPayload): string {
  const harnessName = kindDisplayLabel(payload.harness);
  const p = payload.payload as Record<string, unknown> | null | undefined;
  if (p && typeof p === "object") {
    const tool = typeof p.tool_name === "string" ? p.tool_name : null;
    if (tool) return `${harnessName} needs permission for ${tool}.`;
  }
  return `${harnessName} needs permission.`;
}

// ---------------------------------------------------------------------------
// Dock badge (§11.3)
// ---------------------------------------------------------------------------

let lastBadgeCount = -1;

/**
 * Push a waiting-count to the dock / taskbar badge. Deduped against the
 * previous value so we don't spam the Tauri IPC bus on every re-render.
 * Callers typically wrap this in a `createEffect` that reads
 * `waitingCount()` from the terminal store.
 */
export function syncDockBadge(count: number): void {
  const value = Math.max(0, Math.trunc(count));
  if (value === lastBadgeCount) return;
  lastBadgeCount = value;
  void invoke("set_dock_badge", { count: value }).catch((e) => {
    console.warn("set_dock_badge failed", e);
  });
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** @internal — reset every bit of module state so tests don't bleed. */
export function __resetNotificationCenterForTests(): void {
  lastNotifyAt.clear();
  contextBySession.clear();
  _windowFocused = false;
  setPermissionState("unknown");
  setNotificationBundleId("");
  setNotificationDevMode(false);
  setNotificationStateNote(null);
  lastBadgeCount = -1;
  pendingPermissionKeys.clear();
  pendingPermissionSessions.clear();
  setPendingPermissionCount(0);
  setBadgeMode("all_unread");
  setNotifyOnWaiting(true);
  setNotifyOnDone(true);
  setNotifyBannerEnabled(true);
}

/** @internal — hand the event handler directly so tests don't need Tauri IPC. */
export function __handleAgentStateChangedForTests(payload: AgentStateChangedPayload): void {
  handleAgentStateChanged(payload);
}

/** @internal — directly invoke the permission-event handler from tests. */
export async function __handleNotificationEventForTests(
  payload: NotificationEventPayload,
): Promise<void> {
  await dispatchPermissionNotification(payload);
}

/** @internal — clear every pending permission owned by `sessionId`. */
export function __handleSessionRemovedForTests(sessionId: string): void {
  clearPendingPermissionsForSession(sessionId);
}

/** @internal — mark a pending permission as cleared for tests. */
export function __clearPendingPermissionForTests(permissionKey: string): void {
  clearPendingPermission(permissionKey);
}
