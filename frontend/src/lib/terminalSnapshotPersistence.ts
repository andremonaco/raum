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
 * No compression: the bytes written here are the raw UTF-8 of SerializeAddon's
 * VT stream — there is NO gzip on either side (the `.vtgz` extension on disk is
 * legacy naming; nothing in the frontend or backend (de)compresses). The Rust
 * side hard-caps a single snapshot at `SNAPSHOT_MAX_BYTES` against this
 * *uncompressed* payload, so the cap is reached at the real byte size of the VT
 * text, not an imagined compressed size.
 *
 * Transport: the payload rides the IPC as raw bytes in both directions (the
 * on-disk format is unchanged). Persist passes the `Uint8Array` as the whole
 * invoke payload — Tauri sends ArrayBuffer views as the raw request body —
 * with the session id in an `x-raum-session-id` header; load resolves to an
 * `ArrayBuffer` (empty = no snapshot). The `number[]` shapes are kept as
 * fallbacks for the postMessage transport, where raw bodies degrade to JSON
 * number arrays.
 *
 * Trim story: truncating a VT stream at an arbitrary byte boundary corrupts the
 * parser (a partial CSI/OSC eats the next few KB of input as parameters), so we
 * never byte-trim. On overflow we re-serialize with a smaller scrollback budget
 * until the stream fits. The frontend's xterm scrollback is bounded by
 * `SCROLLBACK_MAX` already, so this fallback rarely fires unless the user is
 * producing very dense full-screen color output.
 */
import { SerializeAddon } from "@xterm/addon-serialize";
import { invoke } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";

const SNAPSHOT_DEBOUNCE_MS = 2000;
/**
 * Hard ceiling on how long a continuously-emitting pane can defer its snapshot.
 * The debounce below is leading-edge (the first write arms a single timer that
 * survives the burst), so a pane that never goes quiet would otherwise only ever
 * checkpoint once every `SNAPSHOT_DEBOUNCE_MS` from the burst start. For a pane
 * under sustained output the freshest content can drift well past the debounce;
 * this cap forces a re-arm at most this far behind the live buffer so a quit /
 * reboot loses at most ~this much tail rather than an unbounded run.
 */
const SNAPSHOT_MAX_STALENESS_MS = 10_000;
const SCROLLBACK_MAX = 100_000;
/**
 * Rows serialized by every persist — routine checkpoint AND quit flush. It is
 * one budget on purpose: the on-disk snapshot is keyed by session id and each
 * save overwrites it wholesale, so a quit flush with a *smaller* budget would
 * replace an existing 10k-row snapshot with a 5k-row one and make a clean
 * shutdown destroy scrollback that a crash would have preserved.
 *
 * SerializeAddon walks the buffer synchronously on the main thread (~200 ms for
 * 5k rows), so asking for the full 100k-row buffer every couple of seconds per
 * pane is a visible hitch. 10k rows keeps a generous recovery tail while
 * bounding the scan; the overflow ladder below still halves DOWN from here if
 * the backend rejects.
 *
 * ponytail: fixed 10k row cap — restores keep the freshest 10k rows, not the
 * full 100k xterm buffer, and a many-pane quit pays ~400 ms of serialize per
 * pane against the backend's bounded quit-flush wait. Upgrade path if either
 * bites: append-only snapshot segments so a persist never has to re-serialize
 * (or shrink) history it already wrote.
 */
const SCROLLBACK_CHECKPOINT = 10_000;
/// Binary-search tries when re-serializing on backend overflow. The xterm
/// buffer is bounded, so 8 halvings always reach `SCROLLBACK_MIN` or below.
const OVERFLOW_RETRIES = 8;
const SCROLLBACK_MIN = 200;

/** Hoisted: a fresh TextEncoder per serialize is pure allocation churn on a
 *  path that runs every couple of seconds per pane. */
const textEncoder = new TextEncoder();

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Map<string, Promise<void>>();
/**
 * Live snapshot sources keyed by session id. Populated by
 * `scheduleTerminalSnapshotPersist` so the quit-time flush can serialize every
 * pending pane even if its debounce timer hasn't fired yet. Cleared by
 * `cancelTerminalSnapshotPersist` on pane unmount (before `term.dispose()`), so
 * a fired timer never serializes a disposed terminal.
 */
const sources = new Map<string, SnapshotSource>();
/** Wall-clock ms when the still-armed debounce timer for a session was set. */
const armedAt = new Map<string, number>();

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

function serializeAt(
  addon: SerializeAddon,
  scrollback: number,
  excludeAltBuffer: boolean,
): Uint8Array | null {
  const text = addon.serialize({ scrollback, excludeAltBuffer });
  if (!text) return null;
  return textEncoder.encode(text);
}

/**
 * Decide whether to exclude the alt buffer from the serialization. Alt-screen
 * TUIs (Codex / OpenCode defaults, fullscreen Claude) repaint their frame from
 * source on every SIGWINCH, so a serialized alt buffer is wasted disk and would
 * corrupt scrollback if replayed into a normal-mode pane. Excluding it persists
 * the durable normal-buffer scrollback that sits *behind* the alt screen, which
 * is the content worth recovering when a provider `--resume` is impossible.
 */
function shouldExcludeAltBuffer(term: Terminal): boolean {
  return term.buffer.active.type === "alternate";
}

/**
 * Produce a VT-encoded snapshot of the buffer. Returns `null` for empty
 * buffers (no scrollback, no visible content) so callers can skip the
 * persist round-trip entirely. When the pane is currently on the alt screen,
 * the alt buffer is excluded so we capture the normal-buffer scrollback only.
 */
export function serializeTerminalSnapshot(source: SnapshotSource): Uint8Array | null {
  return serializeAt(source.addon, SCROLLBACK_MAX, shouldExcludeAltBuffer(source.term));
}

/**
 * Persist the current buffer for `sessionId`. Serialization starts at
 * `SCROLLBACK_CHECKPOINT` rows (a bounded budget) rather than the whole xterm
 * buffer, because SerializeAddon's scan is synchronous main-thread work. If the
 * backend reports the snapshot is over its size cap, re-serialize with
 * progressively smaller budgets (halving DOWN from the starting bound) until it
 * fits or `SCROLLBACK_MIN` is reached. The budget is deliberately not a
 * parameter — see `SCROLLBACK_CHECKPOINT`: a caller-supplied smaller budget
 * shrinks the snapshot already on disk.
 *
 * All errors are swallowed — snapshot persistence is a best-effort recovery
 * cache. A failed write must not break terminal streaming.
 */
export async function persistTerminalSnapshot(
  sessionId: string,
  source: SnapshotSource,
): Promise<void> {
  if (!sessionId) return;
  const excludeAltBuffer = shouldExcludeAltBuffer(source.term);
  let scrollback = SCROLLBACK_CHECKPOINT;
  for (let attempt = 0; attempt < OVERFLOW_RETRIES; attempt += 1) {
    const bytes = serializeAt(source.addon, scrollback, excludeAltBuffer);
    if (!bytes || bytes.byteLength === 0) return;
    try {
      const accepted = await invoke<boolean>("terminal_snapshot_persist", bytes, {
        headers: { "x-raum-session-id": sessionId },
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

/** Fire the persist for a session immediately and track it as inflight. */
function persistNow(sessionId: string, source: SnapshotSource): void {
  if (inflight.has(sessionId)) return;
  const promise = persistTerminalSnapshot(sessionId, source).finally(() => {
    inflight.delete(sessionId);
  });
  inflight.set(sessionId, promise);
}

/**
 * Debounced wrapper. Call this from the xterm `onWriteParsed` callback so
 * we coalesce bursty output into a single snapshot per silence window —
 * SerializeAddon scans the entire buffer (~200 ms for 5k rows in Chrome
 * benchmarks), so running it on every parsed write is a perceptible UI hitch.
 *
 * The debounce is leading-edge: the first write arms a single timer and
 * subsequent writes during the window are absorbed (so a continuous burst would
 * otherwise checkpoint only once, `SNAPSHOT_DEBOUNCE_MS` after the burst start).
 * To bound staleness under sustained output, once the armed timer has been
 * pending longer than `SNAPSHOT_MAX_STALENESS_MS` the next write flushes the
 * current buffer immediately and re-arms a fresh window — so a long-running burst
 * still checkpoints at least every ~`SNAPSHOT_MAX_STALENESS_MS` and a quit/reboot
 * loses at most that much tail rather than the whole run.
 */
export function scheduleTerminalSnapshotPersist(sessionId: string, source: SnapshotSource): void {
  if (!sessionId) return;
  // Always keep the latest live source so the quit flush serializes current
  // content (the source object is stable per pane, but tracking it here is what
  // lets `flushAllTerminalSnapshotsNow` reach panes whose timer hasn't fired).
  sources.set(sessionId, source);
  const existing = timers.get(sessionId);
  if (existing !== undefined) {
    // A timer is already armed. If it has been pending longer than the
    // max-staleness cap, flush right now and re-arm so a long burst still
    // checkpoints periodically instead of only once per burst.
    const since = Date.now() - (armedAt.get(sessionId) ?? 0);
    if (since < SNAPSHOT_MAX_STALENESS_MS) return;
    clearTimeout(existing);
    timers.delete(sessionId);
    persistNow(sessionId, source);
    // fall through to re-arm a fresh debounce window for subsequent output.
  }
  armedAt.set(sessionId, Date.now());
  const timer = setTimeout(() => {
    timers.delete(sessionId);
    armedAt.delete(sessionId);
    const current = sources.get(sessionId);
    if (!current) return;
    persistNow(sessionId, current);
  }, SNAPSHOT_DEBOUNCE_MS);
  timers.set(sessionId, timer);
}

/**
 * Clear the pending debounce timer + tracked source for one session. Called
 * from the pane's `onCleanup` BEFORE `term.dispose()` so a queued timer can
 * never serialize a disposed terminal. Does not touch any inflight persist
 * already in progress — that closes over its own source and completes safely.
 */
export function cancelTerminalSnapshotPersist(sessionId: string): void {
  if (!sessionId) return;
  const timer = timers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(sessionId);
  }
  armedAt.delete(sessionId);
  sources.delete(sessionId);
}

/**
 * Contract 1 (quit-flush): clear every pending debounce timer and persist every
 * tracked live snapshot immediately. Called from `quitFlush.ts` (Agent A) on the
 * `app-will-quit` event so the freshest scrollback lands before the window
 * closes. SerializeAddon is synchronous, so each serialize completes here even
 * though the underlying `terminal_snapshot_persist` invoke is awaited. Resolves
 * once every flushed write settles.
 */
export async function flushAllTerminalSnapshotsNow(): Promise<void> {
  const pending: Array<Promise<void>> = [];
  // Snapshot the keys first — persistNow mutates `inflight` and we delete from
  // `timers`/`sources` as we go.
  for (const [sessionId, source] of Array.from(sources.entries())) {
    const timer = timers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(sessionId);
    }
    armedAt.delete(sessionId);
    // Drop the tracked source: a flush is a quit-time drain, so each session is
    // checkpointed exactly once and a second flush call is a no-op.
    sources.delete(sessionId);
    // Persist directly (do not go through the inflight short-circuit dedupe —
    // we want the freshest serialize, even if a write is mid-flight). Same row
    // budget as the routine checkpoint: the save overwrites the whole file, so
    // a cheaper quit-time serialize would shrink an already-larger snapshot.
    pending.push(persistTerminalSnapshot(sessionId, source));
  }
  // Also await anything already inflight so the caller's ack truly follows all
  // writes.
  for (const p of Array.from(inflight.values())) pending.push(p);
  await Promise.allSettled(pending);
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
    const result = await invoke<ArrayBuffer | number[] | null>("terminal_snapshot_load", {
      sessionId,
    });
    if (!result) return null;
    // `Array.isArray` (not `instanceof ArrayBuffer`) so the discrimination
    // survives cross-realm buffers (e.g. Node-realm ArrayBuffers under jsdom).
    const bytes = Array.isArray(result) ? Uint8Array.from(result) : new Uint8Array(result);
    if (bytes.byteLength === 0) return null;
    return bytes;
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
    await invoke<boolean>("terminal_snapshot_persist", bytes, {
      headers: { "x-raum-session-id": newSessionId },
    });
    await invoke("terminal_snapshot_delete", { sessionId: oldSessionId }).catch(() => {});
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[snapshot] move failed", { oldSessionId, newSessionId, err });
    }
  }
}
