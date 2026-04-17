/**
 * §11 — frontend notification center.
 *
 * Subscribes to the `agent-state-changed` Tauri event (bridged from
 * raum-core's state machine by §7.8), filters on transitions to `waiting`,
 * coalesces rapid re-transitions with a 3s per-agent debounce (§11.2), and
 * dispatches three side effects:
 *
 *   1. An OS notification via `@tauri-apps/plugin-notification` — but only
 *      when the raum window is unfocused (§11.1). Permission is requested
 *      on first launch; if denied we fall back to an in-app banner + set a
 *      one-time flag in `Config.notifications.notifications_hint_shown`
 *      (§11.4).
 *   2. An optional sound played via the `Audio` element, reading the file
 *      path from `Config.notifications.sound` (§11.5).
 *   3. A dock/taskbar badge counter reflecting the cross-project count of
 *      agents currently in `waiting` (§11.3). The counter is driven from
 *      the store; callers only need to invoke `startNotificationCenter`.
 *
 * Clicking an OS notification fires a `terminal-focus-requested` window
 * event carrying the session id (§11.6) and calls the Tauri command
 * `notifications_focus_main` to bring the window forward.
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
import { createSignal } from "solid-js";

import type { AgentKind, AgentState } from "../stores/agentStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentStateChangedPayload {
  session_id: { 0?: string } | string;
  harness: AgentKind;
  from: AgentState;
  to: AgentState;
  via_silence_heuristic: boolean;
}

/** Per-agent notification metadata the caller can optionally supply. */
export interface NotificationContext {
  /** Display name for the originating project — rendered in the title. */
  projectName?: string;
  /** Display name for the worktree — rendered in the body. */
  worktreeName?: string;
}

/** In-app banner surfaced when OS permission is denied (§11.4 fallback). */
export interface InAppBanner {
  id: number;
  title: string;
  body: string;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** §11.2 — 3 s per-agent coalescing window. */
export const NOTIFY_DEBOUNCE_MS = 3_000;

// ---------------------------------------------------------------------------
// Reactive surface the UI can read
// ---------------------------------------------------------------------------

const [banners, setBanners] = createSignal<InAppBanner[]>([]);
/** In-app banners (surfaced only when OS notification permission is denied). */
export { banners };

const [permissionState, setPermissionState] = createSignal<"granted" | "denied" | "unknown">(
  "unknown",
);
export { permissionState };

/** Whether to fire notifications when an agent needs input (`waiting`). */
const [notifyOnWaiting, setNotifyOnWaiting] = createSignal(true);
export { notifyOnWaiting };

/** Whether to fire notifications when an agent finishes (`completed` / `errored`). */
const [notifyOnDone, setNotifyOnDone] = createSignal(true);
export { notifyOnDone };

let bannerCounter = 0;
export function dismissBanner(id: number): void {
  setBanners((prev) => prev.filter((b) => b.id !== id));
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const contextBySession = new Map<string, NotificationContext>();

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
  const t = debounceTimers.get(sessionId);
  if (t !== undefined) {
    clearTimeout(t);
    debounceTimers.delete(sessionId);
  }
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
    console.warn("ensureNotificationPermission failed", e);
    setPermissionState("denied");
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

/** Read `notify_on_waiting` / `notify_on_done` from config and update signals. */
async function loadNotificationConfig(): Promise<void> {
  try {
    const cfg = await invoke<{
      notifications?: {
        notify_on_waiting?: boolean;
        notify_on_done?: boolean;
      };
    }>("config_get");
    setNotifyOnWaiting(cfg.notifications?.notify_on_waiting ?? true);
    setNotifyOnDone(cfg.notifications?.notify_on_done ?? true);
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

async function dispatchWaitingNotification(sessionId: string, harness: AgentKind): Promise<void> {
  if (!notifyOnWaiting()) return;

  const ctx = contextBySession.get(sessionId);
  const title = titleFor(ctx, harness);
  const body = bodyFor(ctx, sessionId);
  const soundPath = await readSoundPath();

  if (soundPath) void playSound(soundPath);

  if (!(await isWindowUnfocused())) return;

  if (permissionState() === "granted") {
    try {
      sendNotification({
        title,
        body,
        extra: { sessionId },
      });
    } catch (e) {
      console.warn("sendNotification failed", e);
    }
  } else {
    bannerCounter += 1;
    const banner: InAppBanner = {
      id: bannerCounter,
      title,
      body,
      sessionId,
    };
    setBanners((prev) => [...prev, banner]);
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

  if (!(await isWindowUnfocused())) return;

  if (permissionState() === "granted") {
    try {
      sendNotification({ title, body, extra: { sessionId } });
    } catch (e) {
      console.warn("sendNotification failed", e);
    }
  } else {
    bannerCounter += 1;
    setBanners((prev) => [...prev, { id: bannerCounter, title, body, sessionId }]);
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

  if (payload.to === "completed" || payload.to === "errored") {
    // Clear any pending waiting-debounce — a done event supersedes it.
    const existing = debounceTimers.get(sessionId);
    if (existing !== undefined) {
      clearTimeout(existing);
      debounceTimers.delete(sessionId);
    }
    void dispatchDoneNotification(sessionId, payload.harness, payload.to);
    return;
  }

  if (payload.to !== "waiting") {
    // Clear any pending debounce for this agent so a `waiting → working →
    // waiting` bounce inside the debounce window still produces exactly
    // one notification per settle.
    const existing = debounceTimers.get(sessionId);
    if (existing !== undefined) {
      clearTimeout(existing);
      debounceTimers.delete(sessionId);
    }
    return;
  }

  // §11.2 — if a notification is already pending for this agent, drop this
  // event. The previously-scheduled timer will fire and cover the combined
  // burst with a single notification.
  if (debounceTimers.has(sessionId)) return;

  const timer = setTimeout(() => {
    debounceTimers.delete(sessionId);
    void dispatchWaitingNotification(sessionId, payload.harness);
  }, NOTIFY_DEBOUNCE_MS);
  debounceTimers.set(sessionId, timer);
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

  // §11.6 — click-to-focus. The `onAction` listener fires when the user
  // clicks the notification body on macOS / Linux.
  const actionListener = await onAction((payload) => {
    const extra = payload.extra;
    const sessionId = typeof extra?.sessionId === "string" ? extra.sessionId : "";
    void invoke("notifications_focus_main").catch(() => {
      /* best-effort */
    });
    if (sessionId) {
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
  });

  return () => {
    unlistenState();
    actionListener.unregister();
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
  };
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
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
  contextBySession.clear();
  bannerCounter = 0;
  setBanners([]);
  setPermissionState("unknown");
  lastBadgeCount = -1;
  windowHandle = null;
  for (const url of audioObjectUrlCache.values()) URL.revokeObjectURL(url);
  audioObjectUrlCache.clear();
  audioInflight.clear();
}

/** @internal — hand the event handler directly so tests don't need Tauri IPC. */
export function __handleAgentStateChangedForTests(payload: AgentStateChangedPayload): void {
  handleAgentStateChanged(payload);
}

/** @internal — peek the number of pending debounce timers. */
export function __pendingDebounceCountForTests(): number {
  return debounceTimers.size;
}
