/**
 * Disk-backed terminal-snapshot persistence.
 *
 * Captures the live xterm.js buffer (visible viewport + scrollback) as a
 * VT-escape-sequence stream via `@xterm/addon-serialize`, then persists it
 * to disk through the Rust backend's `terminal_snapshot_persist` IPC. Bytes
 * are loaded back through `terminal_snapshot_load` on reattach so the user
 * sees their pane content at the same width it had when raum was last
 * running.
 *
 * Why disk instead of localStorage:
 *  - Tauri's WKWebView/WebView2 cap localStorage at ~5 MiB per origin.
 *  - macOS WebKit's 7-day storage policy can purge localStorage without
 *    warning when raum hasn't been opened in a while.
 *  - The Rust backend already handles atomic writes and lifecycle GC; the
 *    snapshot file lives next to `state/sessions.toml` and is deleted when
 *    the owning tmux session is killed.
 *
 * Why SerializeAddon: per-line `translateToString` loses SGR state, hyperlink
 * cells, and the wrap-flag bookkeeping xterm needs to reflow soft-wrapped
 * content on subsequent resize. SerializeAddon emits a self-contained VT
 * stream that, when written into a fresh xterm of equal dimensions,
 * reproduces the buffer faithfully.
 *
 * Trim story: the Rust side hard-caps a single snapshot at 16 MiB. Truncating
 * a VT stream at an arbitrary byte boundary corrupts the parser (a partial
 * CSI/OSC eats the next few KB of input as parameters), so we never byte-trim.
 * On overflow we re-serialize with a smaller scrollback budget until the
 * stream fits. The frontend's xterm scrollback is bounded by `SCROLLBACK_MAX`
 * already, so this fallback rarely fires unless the user is producing very
 * dense full-screen color output.
 */
import { SerializeAddon } from "@xterm/addon-serialize";
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";

const SNAPSHOT_DEBOUNCE_MS = 2000;
const SCROLLBACK_MAX = 100_000;
/// Binary-search tries when re-serializing on backend overflow. The xterm
/// buffer is bounded, so 8 halvings always reach `SCROLLBACK_MIN` or below.
const OVERFLOW_RETRIES = 8;
const SCROLLBACK_MIN = 200;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Map<string, Promise<void>>();

/**
 * SerializeAddon owner for a pane. The addon must be loaded into the same
 * xterm instance whose buffer it's serializing, so we never construct a
 * pane-less serializer here — callers create the addon at xterm init and
 * pass it to the persistence helpers.
 */
export type SnapshotSource = {
  term: Terminal;
  addon: SerializeAddon;
};

function serializeAt(addon: SerializeAddon, scrollback: number): Uint8Array | null {
  const text = addon.serialize({ scrollback });
  if (!text) return null;
  return new TextEncoder().encode(text);
}

/**
 * Produce a VT-encoded snapshot of the buffer. Returns `null` for empty
 * buffers (no scrollback, no visible content) so callers can skip the
 * persist round-trip entirely.
 */
export function serializeTerminalSnapshot(source: SnapshotSource): Uint8Array | null {
  return serializeAt(source.addon, SCROLLBACK_MAX);
}

/**
 * Persist the current buffer for `sessionId`. If the backend reports the
 * snapshot is over its size cap, re-serialize with progressively smaller
 * scrollback budgets until it fits or `SCROLLBACK_MIN` is reached.
 *
 * All errors are swallowed — snapshot persistence is a best-effort recovery
 * cache. A failed write must not break terminal streaming.
 */
export async function persistTerminalSnapshot(
  sessionId: string,
  source: SnapshotSource,
): Promise<void> {
  if (!sessionId) return;
  let scrollback = SCROLLBACK_MAX;
  for (let attempt = 0; attempt < OVERFLOW_RETRIES; attempt += 1) {
    const bytes = serializeAt(source.addon, scrollback);
    if (!bytes || bytes.byteLength === 0) return;
    try {
      const accepted = await invoke<boolean>("terminal_snapshot_persist", {
        sessionId,
        bytes: Array.from(bytes),
      });
      if (accepted) return;
    } catch (err) {
      if (import.meta.env.DEV) {
        console.warn("[snapshot] persist failed", { sessionId, err });
      }
      return;
    }
    if (scrollback <= SCROLLBACK_MIN) return;
    scrollback = Math.max(SCROLLBACK_MIN, Math.floor(scrollback / 2));
  }
}

/**
 * Debounced wrapper. Call this from the xterm `onWriteParsed` callback so
 * we coalesce bursty output into a single snapshot per silence window —
 * SerializeAddon scans the entire buffer (~200 ms for 5k rows in Chrome
 * benchmarks), so running it on every parsed write is a perceptible UI hitch.
 */
export function scheduleTerminalSnapshotPersist(sessionId: string, source: SnapshotSource): void {
  if (!sessionId) return;
  if (timers.has(sessionId)) return;
  const timer = setTimeout(() => {
    timers.delete(sessionId);
    if (inflight.has(sessionId)) return;
    const promise = persistTerminalSnapshot(sessionId, source).finally(() => {
      inflight.delete(sessionId);
    });
    inflight.set(sessionId, promise);
  }, SNAPSHOT_DEBOUNCE_MS);
  timers.set(sessionId, timer);
}

/**
 * Load a previously persisted snapshot. Returns the raw VT bytes ready to
 * `term.write(...)`, or `null` when nothing is stored. Callers must respect
 * the same-width contract: the snapshot is faithful only when the destination
 * terminal has the columns it had at capture time. Width changes between
 * capture and load reflow soft-wrapped lines and leave hard-wrapped (Ink-
 * style) lines at their committed width.
 */
export async function loadTerminalSnapshotBytes(sessionId: string): Promise<Uint8Array | null> {
  if (!sessionId) return null;
  try {
    const result = await invoke<number[] | null>("terminal_snapshot_load", { sessionId });
    if (!result || result.length === 0) return null;
    return Uint8Array.from(result);
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[snapshot] load failed", { sessionId, err });
    }
    return null;
  }
}

/**
 * Move a stored snapshot from one session id to another. Used by the
 * provider-replacement path where raum mints a fresh tmux session id but the
 * pane content from the retired session is still visually relevant.
 */
export async function moveTerminalSnapshot(
  oldSessionId: string,
  newSessionId: string,
): Promise<void> {
  if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) return;
  const bytes = await loadTerminalSnapshotBytes(oldSessionId);
  if (!bytes) return;
  try {
    await invoke<boolean>("terminal_snapshot_persist", {
      sessionId: newSessionId,
      bytes: Array.from(bytes),
    });
    await invoke("terminal_snapshot_delete", { sessionId: oldSessionId }).catch(() => {});
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[snapshot] move failed", { oldSessionId, newSessionId, err });
    }
  }
}
