/**
 * §11 — frontend notification center.
 *
 * Subscribes to the `agent-state-changed` Tauri event (bridged from
 * raum-core's state machine by §7.8), filters on transitions to `waiting`,
 * coalesces rapid re-transitions with a 3s per-agent debounce (§11.2), and
 * dispatches three side effects:
 *
 *   1. An in-app toast via `solid-sonner` (mounted as `<Toaster />`
 *      from `components/ui/sonner.tsx`). Always fires — it's the only
 *      signal that's guaranteed visible in dev builds where the OS
 *      notification plugin silently no-ops, and doubles as a focused-
 *      window reminder in bundled builds.
 *   2. An OS notification via `@tauri-apps/plugin-notification`, only
 *      when the raum window is unfocused (§11.1). Permission is
 *      requested on first launch; on denial we set a one-time flag in
 *      `Config.notifications.notifications_hint_shown` (§11.4).
 *   3. An optional sound played via the `Audio` element, reading the
 *      file path from `Config.notifications.sound` (§11.5).
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
import { getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { createEffect, createRoot, createSignal } from "solid-js";
import { toast } from "solid-sonner";

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
 * True when `requestPermission()` threw (plugin could not reach the OS
 * notification center). On macOS this is the normal outcome for
 * unbundled `tauri dev` builds — the system only registers apps that
 * were launched from a signed `.app` bundle. Surfaced so the UI can
 * show a one-time "System notifications unavailable in dev build"
 * hint that is distinct from a user-initiated denial.
 */
const [osNotificationsUnavailable, setOsNotificationsUnavailable] = createSignal(false);
export { osNotificationsUnavailable };

/** Whether to fire notifications when an agent needs input (`waiting`). */
const [notifyOnWaiting, setNotifyOnWaiting] = createSignal(true);
export { notifyOnWaiting };

/** Whether to fire notifications when an agent finishes (`completed` / `errored`). */
const [notifyOnDone, setNotifyOnDone] = createSignal(true);
export { notifyOnDone };

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

// Deferred window handle; lazily resolved so tests that stub out the tauri
// runtime don't crash on import.
let windowHandle: TauriWindow | null = null;
function getWindowHandle(): TauriWindow | null {
  if (windowHandle) return windowHandle;
  try {
    windowHandle = getCurrentWindow();
  } catch {
    windowHandle = null;
  }
  return windowHandle;
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

/**
 * Request OS notification permission on first launch. On denial, set the
 * one-time hint flag so the UI only surfaces the explainer banner once.
 * Safe to call more than once; subsequent calls are a no-op if the current
 * state has already been resolved to `granted` or `denied`.
 */
export async function ensureNotificationPermission(): Promise<"granted" | "denied"> {
  try {
    if (await isPermissionGranted()) {
      setPermissionState("granted");
      return "granted";
    }
    const response = await requestPermission();
    if (response === "granted") {
      setPermissionState("granted");
      return "granted";
    }
    setPermissionState("denied");
    try {
      await invoke("notifications_mark_hint_shown");
    } catch (e) {
      console.warn("notifications_mark_hint_shown failed", e);
    }
    return "denied";
  } catch (e) {
    // Plugin threw (macOS: unbundled dev build with no registered
    // UNUserNotificationCenter). Fall back to in-app banners + sound
    // and surface the distinct "unavailable" state so the UI can
    // explain why the OS prompt never appeared.
    console.warn("ensureNotificationPermission failed", e);
    setPermissionState("denied");
    setOsNotificationsUnavailable(true);
    try {
      await invoke("notifications_mark_hint_shown");
    } catch (markErr) {
      console.warn("notifications_mark_hint_shown failed", markErr);
    }
    return "denied";
  }
}

// ---------------------------------------------------------------------------
// Dispatch helpers
// ---------------------------------------------------------------------------

function titleFor(ctx: NotificationContext | undefined, harness: AgentKind): string {
  const project = ctx?.projectName ?? "raum";
  return `${project}: ${harness} needs input`;
}

function bodyFor(ctx: NotificationContext | undefined, sessionId: string): string {
  if (ctx?.worktreeName) {
    return `Worktree ${ctx.worktreeName} is awaiting your reply.`;
  }
  return `Session ${sessionId} is awaiting your reply.`;
}

// ObjectURL cache keyed by the absolute on-disk path. The webview can't
// fetch arbitrary `file://` URLs, so we round-trip the bytes through a
// Tauri command once per session and reuse the resulting Blob URL on every
// subsequent notification.
const audioObjectUrlCache = new Map<string, string>();
const audioInflight = new Map<string, Promise<string | null>>();

function mimeForSoundPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".aiff") || lower.endsWith(".aif")) return "audio/aiff";
  if (lower.endsWith(".oga") || lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  return "application/octet-stream";
}

async function objectUrlForSound(path: string): Promise<string | null> {
  const cached = audioObjectUrlCache.get(path);
  if (cached) return cached;
  const inflight = audioInflight.get(path);
  if (inflight) return inflight;

  const job = (async () => {
    try {
      const bytes = await invoke<number[]>("notifications_read_sound_bytes", { path });
      const blob = new Blob([Uint8Array.from(bytes)], { type: mimeForSoundPath(path) });
      const url = URL.createObjectURL(blob);
      audioObjectUrlCache.set(path, url);
      return url;
    } catch (e) {
      console.warn("notifications_read_sound_bytes failed", path, e);
      return null;
    } finally {
      audioInflight.delete(path);
    }
  })();
  audioInflight.set(path, job);
  return job;
}

async function playSound(path: string): Promise<void> {
  const url = await objectUrlForSound(path);
  if (!url) return;
  try {
    const audio = new Audio(url);
    audio.volume = 1.0;
    await audio.play().catch(() => {
      // Swallow: autoplay may be blocked; the notification fires regardless.
    });
  } catch {
    // `new Audio` can throw under locked-down CSP; best-effort only.
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
 * full notify path end-to-end. Always pushes an in-app toast; additionally
 * sends an OS toast when permission is granted. The configured sound also
 * plays so the user hears what they'll hear on a real agent event.
 */
export async function sendTestNotification(): Promise<void> {
  const title = "raum: test notification";
  const body = "If you see this, notifications are working.";
  void playWaitingSound();

  toast.success(title, { description: body });

  if (permissionState() === "granted") {
    try {
      sendNotification({ title, body });
    } catch (e) {
      console.warn("sendTestNotification: sendNotification failed", e);
    }
  }
}

async function isWindowUnfocused(): Promise<boolean> {
  const win = getWindowHandle();
  if (!win) return true;
  try {
    return !(await win.isFocused());
  } catch {
    // Treat focus check failure as "unfocused" — we'd rather fire a
    // missed notification than swallow a real one.
    return true;
  }
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
        badge_mode?: BadgeMode;
      };
    }>("config_get");
    setNotifyOnWaiting(cfg.notifications?.notify_on_waiting ?? true);
    setNotifyOnDone(cfg.notifications?.notify_on_done ?? true);
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
  const body = bodyFor(ctx, sessionId);

  void playWaitingSound();

  // Always push an in-app toast. This is the only signal users get when
  // the OS notification plugin is unavailable (e.g. `tauri dev` on macOS),
  // and it doubles as a clickable reminder for users running a real
  // bundle. The "Open" action fires the same `terminal-focus-requested`
  // CustomEvent that the OS-notification click path uses.
  toast(title, {
    description: body,
    action: { label: "Open", onClick: () => focusSession(sessionId) },
  });

  // In parallel, fire the OS toast when the user has raum in the
  // background. Focused windows don't need two signals; skip the OS
  // toast so we don't stack a macOS notification on top of the in-app one.
  if (permissionState() === "granted" && (await isWindowUnfocused())) {
    try {
      sendNotification({ title, body, extra: { sessionId } });
    } catch (e) {
      console.warn("sendNotification failed", e);
    }
  }
}

async function dispatchDoneNotification(
  sessionId: string,
  harness: AgentKind,
  doneState: "completed" | "errored",
): Promise<void> {
  if (!notifyOnDone()) return;

  const ctx = contextBySession.get(sessionId);
  const project = ctx?.projectName ?? "raum";
  const wt = ctx?.worktreeName ? ` (${ctx.worktreeName})` : "";
  const finished = doneState === "completed" ? "finished" : "errored";
  const title = `${project}: ${harness} ${finished}${wt}`;
  const body =
    doneState === "completed" ? "Agent completed successfully." : "Agent encountered an error.";

  const soundPath = await readSoundPath();
  if (soundPath) void playSound(soundPath);

  // Always push an in-app toast (click → focuses the pane). The OS toast
  // is additive and only fires when raum is in the background so users
  // don't get two notifications for the same event when the window is up.
  const toastKind = doneState === "completed" ? toast.success : toast.error;
  toastKind(title, {
    description: body,
    action: { label: "Open", onClick: () => focusSession(sessionId) },
  });

  if (permissionState() === "granted" && (await isWindowUnfocused())) {
    try {
      sendNotification({ title, body, extra: { sessionId } });
    } catch (e) {
      console.warn("sendNotification failed", e);
    }
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
  const title = `${ctx?.projectName ?? "raum"}: ${payload.harness} needs permission`;
  const summary = permissionSummaryFor(payload);

  void playWaitingSound();

  // Permission toasts stay visible until the user acts on them — auto-
  // dismissal is unsafe because the session stays in `Waiting` forever if
  // the user misses both the OS and in-app signals. A manual dismiss
  // (close button or swipe) is treated as "ignore this request" and
  // aborts the session; the "Open" action just focuses the pane so the
  // user can answer inside the harness.
  toast.warning(title, {
    description: summary,
    duration: Number.POSITIVE_INFINITY,
    action: { label: "Open", onClick: () => focusSession(sessionId) },
    onDismiss: () => {
      if (!sessionId) return;
      void invoke("abort_session", { sessionId }).catch((e) => {
        console.warn("abort_session from toast dismiss failed", e);
      });
    },
  });

  if (permissionState() === "granted") {
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
  const p = payload.payload as Record<string, unknown> | null | undefined;
  if (p && typeof p === "object") {
    const tool = typeof p.tool_name === "string" ? p.tool_name : null;
    if (tool) return `${tool} requires permission — open the terminal to answer.`;
  }
  return "Permission requested — open the terminal to answer.";
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
  setPermissionState("unknown");
  lastBadgeCount = -1;
  windowHandle = null;
  for (const url of audioObjectUrlCache.values()) URL.revokeObjectURL(url);
  audioObjectUrlCache.clear();
  audioInflight.clear();
  pendingPermissionKeys.clear();
  pendingPermissionSessions.clear();
  setPendingPermissionCount(0);
  setBadgeMode("all_unread");
  setNotifyOnWaiting(true);
  setNotifyOnDone(true);
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
