/**
 * §11 — frontend notification center.
 *
 * Subscribes to the `agent-state-changed` Tauri event (bridged from
 * raum-core's state machine by §7.8), filters on transitions to `waiting`,
 * coalesces rapid re-transitions with a per-agent debounce (§11.2), and
 * dispatches three side effects:
 *
 *   1. An OS notification via the Rust `notifications_send` Tauri command
 *      (which calls `UNUserNotificationCenter.add` on macOS via
 *      `objc2-user-notifications`, and `notify-rust`/zbus on Linux). Fires
 *      regardless of window focus — if the user has enabled notifications
 *      in settings they should see every event. Clicking the notification
 *      focuses the owning pane via the Tauri `notifications:clicked`
 *      event the Rust delegate emits. There is NO in-app toast fallback:
 *      the user's "OS only, even when system notifications are off" rule
 *      means we always attempt the OS path and accept that macOS will
 *      drop the notification if permission is denied.
 *   2. An optional sound played via the backend `notifications_play_sound`
 *      command, which delegates to the OS event-sound player (afplay /
 *      canberra-gtk-play). Path from `Config.notifications.sound` (§11.5).
 *      We don't use the webview's `<audio>` element because WKWebView
 *      registers it with macOS's Now Playing session and pauses Spotify.
 *   3. A dock/taskbar badge counter reflecting the cross-project count
 *      of agents currently in `waiting` (§11.3). The counter is driven
 *      from the store; callers only need to invoke
 *      `startNotificationCenter`.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createEffect, createRoot, createSignal } from "solid-js";

import { kindDisplayLabel } from "./agentKind";
import { agentStore, markAcknowledged, unreadAgentCount } from "../stores/agentStore";
import type { AgentKind, AgentState, Reliability } from "../stores/agentStore";
import { activeProjectSlug, projectBySlug } from "../stores/projectStore";
import { listHarnessSessions, terminalStore } from "../stores/terminalStore";

/**
 * §11 — kind tag embedded in the OS notification's request identifier so
 * [`notifications_clear`] can selectively dismiss notifications by
 * `(sessionId, kind)`. `"done"` covers completed + errored; `"needs_input"`
 * covers waiting + permission. Both backend and frontend must agree.
 */
type NotificationKind = "done" | "needs_input";

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
 * not; we always fire the OS notification — the user explicitly opted out
 * of in-app toasts even for permission requests.
 */
interface NotificationEventPayload {
  harness: AgentKind;
  event: string;
  session_id?: string | null;
  request_id?: string | null;
  permission_key: string;
  payload?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Window in which a `notification-event` (PermissionRequest) and the
 * back-to-back `agent-state-changed` → `waiting` transition that follows
 * it are considered the same notification. The backend emits both in the
 * same loop iteration (`src-tauri/src/commands/agent.rs`), so without this
 * the user would hear two sounds and see two banners for one event.
 * The badge / pending-permission counters update unconditionally; this
 * gate only affects sound and banner emission.
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
 * notifications to. Surfaced in the Settings badge so the user knows which
 * app's permission to toggle.
 */
const [notificationBundleId, setNotificationBundleId] = createSignal("");
export { notificationBundleId };

/**
 * True when running unbundled (`task dev`). On macOS that means there is
 * no Info.plist for `UNUserNotificationCenter` to attach to — the auth
 * probe early-returns `"unknown"`. Surfaced so Settings can hint that a
 * `task build` is needed to verify the full path.
 */
const [notificationDevMode, setNotificationDevMode] = createSignal(false);
export { notificationDevMode };

/**
 * Optional human-readable note returned by the backend, used for surface-level
 * caveats like the dev-mode "no Info.plist" hint or the Linux missing-daemon
 * message.
 */
const [notificationStateNote, setNotificationStateNote] = createSignal<string | null>(null);
export { notificationStateNote };

/** Whether to fire notifications when an agent needs input (`waiting`). */
const [notifyOnWaiting, setNotifyOnWaiting] = createSignal(true);
export { notifyOnWaiting };

/** Whether to fire notifications when an agent finishes (`completed` / `errored`). */
const [notifyOnDone, setNotifyOnDone] = createSignal(true);
export { notifyOnDone };

/**
 * Master delivery switch for OS notification banners. When `false`, every
 * dispatch path short-circuits before calling the OS — the user asked for
 * a silent-with-badge experience. The dock badge is independent (driven
 * by `badgeMode`) so counts keep updating.
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

  // Per the user's rule, "needs input" notifications are sticky until the
  // harness is running again. The two callers of this helper both fit that
  // moment exactly:
  //   * `handleAgentStateChanged` — invoked on `waiting → !waiting`.
  //   * `agent-session-removed` — the session is gone entirely.
  // Drop the OS Notification Center entry alongside the in-memory cleanup
  // above so the user doesn't see a stale "needs input" banner.
  void clearOsNotifications(sessionId, ["needs_input"]);
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/**
 * Timestamp (ms since epoch) of the last emitted sound/banner per session.
 * Consulted by `shouldDedupNotify` to suppress the second half of a
 * permission-event + waiting-transition pair. See {@link NOTIFY_DEDUP_MS}.
 */
const lastNotifyAt = new Map<string, number>();

function shouldDedupNotify(sessionId: string, now: number): boolean {
  const prev = lastNotifyAt.get(sessionId);
  if (prev !== undefined && now - prev < NOTIFY_DEDUP_MS) return true;
  lastNotifyAt.set(sessionId, now);
  return false;
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
 * Probe the actual OS authorization state via the Rust backend, which
 * uses `UNUserNotificationCenter.getNotificationSettings` on macOS and
 * the session notification service on Linux. Updates the reactive signals
 * and returns the raw payload for callers that need the bundle/dev fields.
 *
 * Note: `permissionState` is informational for the Settings UI badge.
 * The dispatchers no longer gate on it — every notification attempts the
 * OS path so denied users still get a one-time macOS authorization
 * prompt on first send, and the user's "OS only, even when off" rule
 * means we never substitute an in-app surface.
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
 * Best-effort first-launch initialiser. Resolves the current authorization
 * state and records that the one-time hint has been shown if the user has
 * not granted permission. The macOS permission prompt is triggered by the
 * first real `notifications_send` invocation — typically the user's
 * "Send test" click, or the first transition that hits the dispatcher.
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

/**
 * Fire an OS notification via the Rust `notifications_send` command.
 * Errors are swallowed and logged — notifications are best-effort UX and
 * must never abort a state-change handler.
 *
 * `kind` is embedded in the request identifier on macOS so the
 * `notifications_clear` command can selectively dismiss this notification
 * later (on tab activation or when the harness leaves `waiting`).
 */
async function emitOsNotification(
  title: string,
  body: string,
  sessionId: string | null | undefined,
  kind: NotificationKind,
): Promise<void> {
  try {
    await invoke("notifications_send", {
      args: {
        title,
        body,
        sessionId: sessionId ?? null,
        kind,
      },
    });
  } catch (e) {
    console.warn("notifications_send failed", e);
  }
}

/**
 * Ask the backend to dismiss every delivered notification owned by
 * `sessionId` whose embedded kind matches one of `kinds`. macOS-only
 * dismissal; Linux is a no-op on the backend (notify-rust has no clean
 * dismiss API). Best-effort — failures are logged and swallowed.
 */
async function clearOsNotifications(sessionId: string, kinds: NotificationKind[]): Promise<void> {
  if (!sessionId || kinds.length === 0) return;
  try {
    await invoke("notifications_clear", {
      args: {
        sessionId,
        kinds,
      },
    });
  } catch (e) {
    console.warn("notifications_clear failed", e);
  }
}

/**
 * Build `{ title, body }` for an agent-state notification. Title carries
 * project identity ("<sigil> <projectName>", with either side dropped if
 * the project can't be resolved), body carries the calm verb phrase
 * ("Claude needs you.", "Codex finished.", "Codex errored."). Reads
 * project metadata directly from the live stores so renames are picked
 * up without any extra wiring.
 */
function composeNotification(
  sessionId: string,
  harness: AgentKind,
  verb: "needs you" | "finished" | "errored",
): { title: string; body: string } {
  const slug = terminalStore.byId[sessionId]?.project_slug ?? null;
  const project = slug ? (projectBySlug().get(slug) ?? null) : null;
  const sigil = project?.sigil ?? "";
  const name = project?.name ?? "";
  const title = [sigil, name].filter(Boolean).join(" ");
  const body = `${kindDisplayLabel(harness)} ${verb}.`;
  return { title, body };
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
 * debounce gate so the user can audition a sound without an agent
 * actually transitioning to `waiting`.
 */
export async function previewSound(path: string): Promise<void> {
  if (!path) return;
  await playSound(path);
}

/**
 * Dispatch the "focus this session's pane" CustomEvent that `TerminalPane`
 * subscribes to. Shared by the OS-notification click handler so click and
 * future test paths converge on the same behavior.
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
 * full notify path end-to-end. Always invokes `notifications_send` — the
 * first send on macOS doubles as the OS-level permission prompt, since
 * `tauri-plugin-notification` is no longer involved. Re-reads the
 * authorization state afterwards so the badge reflects the user's choice
 * immediately.
 */
export async function sendTestNotification(): Promise<void> {
  const title = "raum: test notification";
  const body = "If you see this, notifications are working.";
  void playWaitingSound();
  // Tag the test as `done` so an opportunistic `notifications_clear` for a
  // real session never accidentally targets it (no session id is passed).
  await emitOsNotification(title, body, null, "done");
  // The first send on macOS may surface the OS authorization prompt;
  // re-probe so the badge picks up the new state without forcing the
  // user to reopen settings.
  await refreshNotificationAuthorization();
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

  const { title, body } = composeNotification(sessionId, harness, "needs you");

  void playWaitingSound();

  // Banner master switch off → user opted into silent-with-badge. Skip the
  // OS notification; the dock badge still ticks via
  // `handleAgentStateChanged`'s unread/pending counters.
  if (!notifyBannerEnabled()) return;

  await emitOsNotification(title, body, sessionId, "needs_input");
}

async function dispatchDoneNotification(
  sessionId: string,
  harness: AgentKind,
  doneState: "completed" | "errored",
): Promise<void> {
  if (!notifyOnDone()) return;

  const { title, body } = composeNotification(
    sessionId,
    harness,
    doneState === "completed" ? "finished" : "errored",
  );

  const soundPath = await readSoundPath();
  if (soundPath) void playSound(soundPath);

  // Banner master switch off → silent-with-badge.
  if (!notifyBannerEnabled()) return;

  await emitOsNotification(title, body, sessionId, "done");
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

interface NotificationClickedPayload {
  sessionId?: string | null;
}

/**
 * Install the notification center. Returns a disposer that unregisters both
 * the `agent-state-changed` listener and the OS notification click handler.
 *
 * Callers should invoke this once at app start (after the initial config
 * hydration); repeated invocations install parallel listeners and waste IPC.
 */
export async function startNotificationCenter(): Promise<UnlistenFn> {
  await ensureNotificationPermission();
  await loadNotificationConfig();

  const unlistenState = await listen<AgentStateChangedPayload>("agent-state-changed", (ev) => {
    handleAgentStateChanged(ev.payload);
  });
  const unlistenRemoved = await listen<{ session_id: string }>("agent-session-removed", (ev) => {
    const sessionId = ev.payload.session_id;
    if (!sessionId) return;
    clearPendingPermissionsForSession(sessionId);
  });

  const unlistenPermission = await listen<NotificationEventPayload>("notification-event", (ev) => {
    void dispatchPermissionNotification(ev.payload);
  });

  // §11.6 — click-to-focus. The Rust `UNUserNotificationCenterDelegate`
  // emits `notifications:clicked` with `{ sessionId }` when the user taps
  // a banner or a Notification Center entry.
  const unlistenClick = await listen<NotificationClickedPayload>("notifications:clicked", (ev) => {
    const sessionId = ev.payload.sessionId ?? "";
    void invoke("notifications_focus_main").catch(() => {
      /* best-effort */
    });
    focusSession(sessionId);
  });

  // §11.3 — mode-aware dock/taskbar badge driver. Reads `badgeMode` +
  // `pendingPermissionCount` + `unreadAgentCount` so the badge stays in
  // sync with whichever verbosity level the user has picked.
  //
  // Tab-activation effect (sibling): when the user switches to a project
  // tab, every session in that project that's currently in `completed` /
  // `errored` is implicitly acknowledged — the notification has done its
  // job, the user is looking at the project. Drop the in-app
  // unread-contribution and ask the OS to remove the matching banners
  // from Notification Center. `waiting` deliberately stays sticky.
  const disposeReactive = createRoot((dispose) => {
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

    createEffect(() => {
      const slug = activeProjectSlug();
      if (!slug) return;
      const records = listHarnessSessions(slug);
      for (const record of records) {
        const sessionId = record.session_id;
        if (!sessionId) continue;
        const agent = agentStore.sessions[sessionId];
        if (!agent) continue;
        if (agent.state !== "completed" && agent.state !== "errored") continue;
        markAcknowledged(sessionId);
        void clearOsNotifications(sessionId, ["done"]);
      }
    });

    return dispose;
  });

  return () => {
    unlistenState();
    unlistenRemoved();
    unlistenPermission();
    unlistenClick();
    disposeReactive();
    lastNotifyAt.clear();
  };
}

/**
 * Surface a permission-request notification. Always fires the OS banner
 * (subject to `notifyBannerEnabled`). Clicking the banner brings the pane
 * forward via the `notifications:clicked` listener; the user answers
 * inside the harness afterwards.
 */
async function dispatchPermissionNotification(payload: NotificationEventPayload): Promise<void> {
  if (!payload.permission_key) return;
  const isNew = addPendingPermission(payload.permission_key, payload.session_id ?? null);
  // Badge/pending counters are updated above regardless. The rest of
  // this function only runs when the permission key is new AND the
  // session hasn't already notified within `NOTIFY_DEDUP_MS` (prevents
  // the back-to-back `notification-event` + `agent-state-changed` pair
  // from double-firing sound + banner).
  if (!isNew) return;
  const sessionId = payload.session_id ?? "";
  if (sessionId && shouldDedupNotify(sessionId, Date.now())) return;

  const title = "Permission requested";
  const summary = permissionSummaryFor(payload);

  void playWaitingSound();

  // Banner master switch off → silent-with-badge. The pending-permission
  // counter already incremented above (drives the dock badge in Critical
  // mode), so the user still notices; we just don't interrupt with a
  // banner.
  if (!notifyBannerEnabled()) return;

  await emitOsNotification(title, summary, sessionId || null, "needs_input");
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
