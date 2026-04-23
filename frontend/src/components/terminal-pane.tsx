/**
 * §4.1–§4.6 — `<TerminalPane>`.
 *
 * Owns a single xterm.js `Terminal` instance for the pane's lifetime:
 *   - §4.1 wired to the `terminal_spawn` Tauri command via a `Channel<Uint8Array>`;
 *          raw bytes written straight into `term.write(...)`. Scrollback capped
 *          at 10 000 lines.
 *   - §4.2 the renderer scheduler installs an initial canvas addon and promotes
 *          to WebGL on focus.
 *   - §4.3 WebKitGTK (Linux) defaults every pane to canvas unless
 *          `config.toml.rendering.webgl_on_linux = true`.
 *   - §4.4 fit addon → `terminal_resize(sessionId, cols, rows)` on every resize.
 *   - §4.5 per-keystroke `terminal_send_keys(sessionId, keys)`.
 *   - §4.6 `borderColor` prop applied to the pane chrome via a Solid signal;
 *          prop updates never re-init xterm.
 *
 * The pane also registers itself in the terminal registry (§4.7) so the global
 * search panel can iterate every live buffer.
 */

import {
  Component,
  For,
  Show,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
} from "solid-js";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";

import type { AgentKind } from "../lib/agentKind";
import { applyAgentStateToTerminal, isHarnessKind, markOutput } from "../stores/terminalStore";
import { type AgentState, updateSessionState } from "../stores/agentStore";
import { registerPane, requestWebgl, unregisterPane } from "../lib/rendererScheduler";
import {
  registerTerminal,
  unregisterTerminal,
  type TerminalBufferKind,
} from "../lib/terminalRegistry";
import { dropTargetPaneId } from "../lib/fileDrop";
import { SCROLLBACK_DEFAULT } from "../lib/scrollbackConfig";
import { isViewportAtBottom, shouldAutoStickToBottomOnResize } from "../lib/terminalResize";
import { getXtermOptions } from "../lib/xtermConfig";
import { getCurrentXtermTheme, subscribeThemeChange } from "../lib/theme/themeController";
import { FALLBACK_XTERM_THEME } from "../lib/theme/toXtermTheme";
import { ChevronDownIcon, CopyIcon } from "./icons";

export interface TerminalPaneProps {
  /** Pre-existing tmux session to re-attach to; omit to spawn a fresh one. */
  sessionId?: string;
  kind: AgentKind;
  cwd?: string;
  projectSlug?: string;
  worktreeId?: string;
  /** Hex string like `#ff00aa` (§4.6). Prop changes only update the border. */
  borderColor?: string;
  /** Called once after `terminal_spawn` resolves with the new session id. */
  onSpawned?: (sessionId: string) => void;
  /** Called when the user clicks the exit overlay to dismiss the pane. */
  onRequestClose?: () => void;
}

interface RenderingConfig {
  webgl_on_linux?: boolean;
}

interface RaumConfig {
  rendering?: RenderingConfig;
}

/** Pull the harness state the backend seeded from `sessions.toml` after
 *  `terminal_reattach` resolves. The reattach path registers the state
 *  machine synchronously, so by the time this invoke fires the machine
 *  exists — no race with the async `listen()` handshake that powers the
 *  live `agent-state-changed` stream. Populates both the agent store and
 *  the terminal store's `workingState` so top-row counters and per-pane
 *  indicators render the correct state on app reload. */
async function hydrateHarnessStateAfterReattach(sessionId: string, kind: AgentKind): Promise<void> {
  try {
    const state = await invoke<AgentState | null>("agent_state", {
      sessionId,
    });
    if (!state) return;
    updateSessionState(sessionId, kind, state);
    applyAgentStateToTerminal(sessionId, state);
  } catch (e) {
    console.warn("[TerminalPane] agent_state hydrate failed", e);
  }
}

function isWebKitGtk(): boolean {
  // §4.3 — Tauri on Linux uses WebKitGTK; the exact substring match is the
  // documented heuristic.
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return ua.includes("WebKit") && /Linux/.test(ua);
}

async function shouldForbidWebgl(): Promise<boolean> {
  if (!isWebKitGtk()) return false;
  try {
    const cfg = await invoke<RaumConfig>("config_get");
    return !cfg?.rendering?.webgl_on_linux;
  } catch {
    // If config can't be read, stay on the safe side on Linux.
    return true;
  }
}

interface SpawnArgs {
  project_slug?: string;
  worktree_id?: string;
  kind: AgentKind;
  cwd?: string;
  /** Measured xterm cols/rows so the harness boots at the real size. */
  cols?: number;
  rows?: number;
}

/** §4.4 — debounce resize pushes so gridstack drag doesn't flood tmux. */
const RESIZE_DEBOUNCE_MS = 100;

/** Spawn gate: below these dims the host isn't laid out yet and fit returns junk. */
const MIN_SPAWN_COLS = 20;
const MIN_SPAWN_ROWS = 5;
/** Reattach can tolerate much smaller panes because the harness already exists. */
const MIN_REATTACH_COLS = 8;
const MIN_REATTACH_ROWS = 2;

/** Upper bound before we give up waiting for `document.fonts.ready`. */
const FONTS_READY_TIMEOUT_MS = 500;

/** Duration the "Copied" flash stays visible after an auto-copy (ms). */
const COPY_FLASH_MS = 900;

interface HistoryOverlayState {
  lines: string[];
  highlightRow: number | null;
}

export const TerminalPane: Component<TerminalPaneProps> = (props) => {
  const paneId = createUniqueId();
  let host: HTMLDivElement | undefined;
  let historyViewport: HTMLDivElement | undefined;

  // Exit overlay state: set when the backend reports the process exited naturally.
  const [exitState, setExitState] = createSignal<{ code: number } | null>(null);
  let unlistenProcessExited: UnlistenFn | null = null;

  // §4.6 — Solid signal for the border so prop changes don't re-init xterm.
  // The effect below keeps the signal in sync with `props.borderColor`; the
  // xterm.js instance is untouched because the border is applied to the
  // outer chrome, not the xterm host element.
  const [borderColor, setBorderColor] = createSignal<string>(props.borderColor ?? "transparent");
  createEffect(() => {
    setBorderColor(props.borderColor ?? "transparent");
  });

  const [sessionId, setSessionId] = createSignal<string | null>(props.sessionId ?? null);
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null);
  const [copiedFlash, setCopiedFlash] = createSignal<boolean>(false);
  const [isScrolledUp, setIsScrolledUp] = createSignal<boolean>(false);
  const [historyOverlay, setHistoryOverlay] = createSignal<HistoryOverlayState | null>(null);

  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let search: SearchAddon | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let copyFlashTimer: ReturnType<typeof setTimeout> | null = null;
  let resizeRepinTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollDisposable: IDisposable | null = null;
  let resizeRepinDisposable: IDisposable | null = null;
  let unsubscribeTheme: (() => void) | null = null;
  let resizeRepinRaf: number | null = null;
  // Observes the grid root's `.is-resizing` class so we can defer the real
  // `terminal_resize` invoke until a divider drag ends instead of firing
  // every debounced ResizeObserver tick. Tmux emits a full composite
  // repaint on each resize; every repaint's trailing `\r\n` at the bottom
  // row pushes a line into xterm's scrollback. Doing ONE resize per drag
  // instead of ~20 cuts the per-drag pollution to a single line.
  let gridMutationObserver: MutationObserver | null = null;
  // Whether a drag ended with a fit/resize still pending. If the final
  // ResizeObserver tick happened while `is-resizing` was still set, we
  // skipped the tmux resize; the MutationObserver flushes it once the
  // class is removed.
  let resizePendingFromDrag = false;

  const normalBuffer = () => term?.buffer.normal ?? null;
  const hasDetachedHistory = (): boolean => {
    if (!term) return false;
    return term.buffer.active.type === "alternate" && term.buffer.normal.length > 0;
  };
  const openHistoryOverlay = (targetRow: number | null = null): void => {
    const buffer = normalBuffer();
    if (!buffer) return;
    const lines: string[] = [];
    for (let row = 0; row < buffer.length; row++) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    }
    if (lines.length === 0) return;
    setHistoryOverlay({ lines, highlightRow: targetRow });
    if (targetRow === null) return;
    requestAnimationFrame(() => {
      const node = historyViewport?.querySelector<HTMLElement>(`[data-history-row="${targetRow}"]`);
      node?.scrollIntoView({ block: "center" });
    });
  };
  const syncScrollState = (): void => {
    setIsScrolledUp(!isViewportAtBottom(term));
  };
  const clearResizeRepin = (): void => {
    if (resizeRepinTimer !== null) {
      clearTimeout(resizeRepinTimer);
      resizeRepinTimer = null;
    }
    if (resizeRepinRaf !== null) {
      cancelAnimationFrame(resizeRepinRaf);
      resizeRepinRaf = null;
    }
    try {
      resizeRepinDisposable?.dispose();
    } catch {
      /* best-effort */
    }
    resizeRepinDisposable = null;
  };
  const scheduleResizeRepin = (waitForWrite: boolean): void => {
    if (!term || !shouldAutoStickToBottomOnResize(props.kind)) return;
    clearResizeRepin();
    const target = term;
    let done = false;
    const repin = (): void => {
      if (done) return;
      done = true;
      clearResizeRepin();
      try {
        target.scrollToBottom();
      } catch {
        /* best-effort */
      }
      if (term === target) syncScrollState();
    };
    resizeRepinRaf = requestAnimationFrame(() => {
      const nestedRaf = requestAnimationFrame(() => {
        resizeRepinRaf = null;
        repin();
      });
      resizeRepinRaf = nestedRaf;
    });
    if (waitForWrite) {
      resizeRepinDisposable = target.onWriteParsed(repin);
      resizeRepinTimer = setTimeout(() => {
        resizeRepinTimer = null;
        repin();
      }, 150);
    }
  };

  onMount(() => {
    if (!host) return;

    try {
      term = new Terminal(
        getXtermOptions({
          fontSize: 13,
          fontFamily: '"JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace',
          scrollback: SCROLLBACK_DEFAULT,
          theme: getCurrentXtermTheme() ?? FALLBACK_XTERM_THEME,
        }),
      );
      fit = new FitAddon();
      search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);

      // Shift+Enter → ESC+CR (Alt/Option+Enter convention). xterm.js by
      // default sends a bare `\r` for both Enter and Shift+Enter, so the
      // harness can't distinguish them. `\x1b\r` is the sequence iTerm2's
      // built-in Shift+Enter binding emits and that Claude Code, Codex,
      // and OpenCode all interpret as "insert newline without submit."
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== "keydown") return true;
        if (ev.key === "Enter" && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
          const id = sessionId();
          if (id) {
            void invoke("terminal_send_keys", { sessionId: id, keys: "\x1b\r" }).catch((e) => {
              console.error("[TerminalPane] terminal_send_keys (shift+enter) failed", e);
            });
          }
          ev.preventDefault();
          return false;
        }
        return true;
      });

      term.open(host);

      // Track scroll position so the pane can surface a "jump to bottom"
      // button while the viewport is detached from the tail. xterm fires
      // `onScroll` both on user scroll and when new output advances baseY,
      // so this also keeps the button visible when content arrives while
      // the user is reading history.
      scrollDisposable = term.onScroll(() => {
        syncScrollState();
      });

      // Live retheme — when the user picks a different VSCode theme, push
      // the new xterm `ITheme` into this instance without recreating it.
      // xterm.js `term.options.theme = ...` triggers an internal repaint that
      // preserves the scroll position and the PTY connection.
      unsubscribeTheme = subscribeThemeChange((next) => {
        if (!term) return;
        term.options.theme = next.xterm;
      });
    } catch (err) {
      // jsdom lacks `matchMedia` and a real canvas context, so xterm.js
      // can't fully initialize during unit tests. Swallow the error so the
      // host page keeps rendering; real browsers (Tauri webview) succeed.
      console.warn("[TerminalPane] xterm.js init failed", err);
      setErrorMsg(String(err));
      return;
    }

    // Register the pane with the renderer scheduler first (installs canvas),
    // then optionally promote to WebGL once we know the platform policy.
    void (async () => {
      const forbid = await shouldForbidWebgl();
      if (!term) return;
      registerPane(paneId, term, { forbidWebgl: forbid });
      // Focusing the pane promotes it to WebGL (§4.2).
      if (!forbid) requestWebgl(paneId);
    })();

    // Subscribe to process-exit events from the backend monitor task. When the
    // shell/harness exits naturally (Ctrl-D / Ctrl-C) we show the blur overlay
    // instead of auto-closing the pane.
    void (async () => {
      unlistenProcessExited = await listen<{ sessionId: string; exitCode: number }>(
        "terminal:process-exited",
        (ev) => {
          const id = sessionId();
          if (id && ev.payload.sessionId === id) {
            setExitState({ code: ev.payload.exitCode });
          }
        },
      );
    })();

    // §4.1 — raw byte channel. Kept outside the spawn gate so reattach paths
    // can hand it to `terminal_spawn` too; today reattach uses `props.sessionId`
    // and skips the spawn but the channel is harmless when unused.
    //
    // NB: Tauri v2 delivers `InvokeResponseBody::Raw` to the webview as an
    // `ArrayBuffer` (small payloads via eval of `new Uint8Array(...).buffer`,
    // large payloads via fetch → `Response.arrayBuffer()`). xterm.js `write`
    // accepts `string | Uint8Array`, not ArrayBuffer, so we always wrap here.
    const channel = new Channel<ArrayBuffer | Uint8Array | number[]>();
    channel.onmessage = (data) => {
      try {
        let bytes: Uint8Array;
        if (data instanceof Uint8Array) {
          bytes = data;
        } else if (data instanceof ArrayBuffer) {
          bytes = new Uint8Array(data);
        } else if (Array.isArray(data)) {
          bytes = Uint8Array.from(data);
        } else {
          // Tauri's large-payload fetch path hands back a Response-like object
          // whose body needs to be read. Guard anyway so we don't silently drop.
          console.warn("[TerminalPane] unexpected channel payload", data);
          return;
        }
        term?.write(bytes);
        const id = sessionId();
        if (id) markOutput(id);
      } catch (err) {
        console.error("[TerminalPane] write failed", err);
      }
    };

    // §4.4 — debounced resize plumbing. Every observer tick runs fit.fit() and
    // pushes cols/rows to tmux, but we coalesce rapid-fire ticks (gridstack
    // drag, window resize) so the harness sees at most one SIGWINCH per settle.
    //
    // Crucially: we DO NOT hook `term.onResize` — fit.fit() triggers it, which
    // would produce a duplicate `terminal_resize` invoke per host change.
    let lastCols = -1;
    let lastRows = -1;
    const pushResize = (): void => {
      if (!term || !fit) return;
      const shouldRepin = shouldAutoStickToBottomOnResize(props.kind) && isViewportAtBottom(term);
      try {
        fit.fit();
      } catch {
        return;
      }
      const id = sessionId();
      if (!id) return;
      if (term.cols === lastCols && term.rows === lastRows) return;
      lastCols = term.cols;
      lastRows = term.rows;
      if (shouldRepin) scheduleResizeRepin(false);
      void invoke("terminal_resize", {
        sessionId: id,
        cols: term.cols,
        rows: term.rows,
      })
        .then(() => {
          if (shouldRepin) scheduleResizeRepin(true);
        })
        .catch((e) => {
          console.error("[TerminalPane] terminal_resize failed", e);
        });
    };
    const scheduleResize = (): void => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        pushResize();
      }, RESIZE_DEBOUNCE_MS);
    };

    // §4.1 — gated spawn. Harnesses (Ink-based TUIs) paint their banner at
    // the moment of attach, so the very first PTY frame should land at the
    // real viewport dimensions. Wait until we have fitted dims before the
    // backend creates the tmux session.
    //
    // Reattach path: if we already have a persisted `sessionId`, ask the
    // backend to open a new PTY-attached `tmux attach-session` against the
    // surviving tmux session instead of creating a new one. tmux's attached
    // client redraws the viewport natively on connect, so xterm shows the
    // current pane state without any custom replay. On any failure (session
    // gone after reap, registry mismatch) fall back to `trySpawn` — the
    // backend returns a structured "not-found" string for that case.
    let hasSpawned = false;
    const persistedSessionId = props.sessionId;

    const tryReattach = (): void => {
      if (hasSpawned || !persistedSessionId) return;
      if (!term || !fit) return;
      // Measure xterm's current dims so the backend opens the PTY at the
      // right size — tmux's attached client uses the PTY size as the
      // effective viewport, so this size flows straight through to the
      // inner harness's first SIGWINCH-free paint.
      try {
        fit.fit();
      } catch {
        return;
      }
      const cols = term.cols;
      const rows = term.rows;
      if (cols < MIN_REATTACH_COLS || rows < MIN_REATTACH_ROWS) return;
      // Mark as spawned synchronously so the resize observer doesn't race
      // into trySpawn while we're still negotiating with the backend.
      hasSpawned = true;
      lastCols = cols;
      lastRows = rows;
      setSessionId(persistedSessionId);
      void invoke<string>("terminal_reattach", {
        args: {
          session_id: persistedSessionId,
          kind: props.kind,
          project_slug: props.projectSlug,
          worktree_id: props.worktreeId,
          cols,
          rows,
        },
        onData: channel,
      })
        .then((id) => {
          // Success — the output channel is live. Resize will be pushed by
          // the observer's first post-attach tick below.
          props.onSpawned?.(id);
          // Pull the harness state the backend seeded from `sessions.toml`.
          // Runs once per reattach; the live `agent-state-changed` stream
          // takes over afterwards. Without this pull the reloaded pane
          // would render as idle until the first real hook fired, masking
          // any waiting-for-input harness across the restart.
          if (isHarnessKind(props.kind)) {
            void hydrateHarnessStateAfterReattach(id, props.kind);
          }
        })
        .catch((e) => {
          // Either the tmux session is gone (expected after `kill-server`
          // or a long absence past reap_stale) or something transient
          // failed. Either way: release the gate and let `trySpawn` create
          // a fresh session. The user's scrollback from last time is lost,
          // but the pane works.
          console.warn("[TerminalPane] terminal_reattach failed — spawning fresh", e);
          hasSpawned = false;
          setSessionId(null);
          // Next ResizeObserver tick will call trySpawn via the dual-mode
          // observer below; also kick one inline in case the pane was
          // already fully measured.
          trySpawn();
        });
    };

    const trySpawn = (): void => {
      if (hasSpawned) return;
      if (!term || !fit) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const cols = term.cols;
      const rows = term.rows;
      if (cols < MIN_SPAWN_COLS || rows < MIN_SPAWN_ROWS) return;
      // Mark as spawned synchronously so the observer can't double-fire.
      hasSpawned = true;
      lastCols = cols;
      lastRows = rows;
      const args: SpawnArgs = {
        project_slug: props.projectSlug,
        worktree_id: props.worktreeId,
        kind: props.kind,
        cwd: props.cwd,
        cols,
        rows,
      };
      void invoke<string>("terminal_spawn", {
        args,
        onData: channel,
      })
        .then((id) => {
          setSessionId(id);
          props.onSpawned?.(id);
        })
        .catch((e) => {
          console.error("[TerminalPane] terminal_spawn failed", e);
          setErrorMsg(String(e));
          // Spawn failed — let a later resize retry by releasing the gate.
          hasSpawned = false;
        });
    };

    // §4.4 — dual-mode observer: pre-spawn it triggers trySpawn; post-spawn
    // it decides whether to debounce-resize or defer-until-drag-end. Solid's
    // ref assignment has already run by the time onMount fires, so `host`
    // is guaranteed non-null here.
    //
    // When the user drags a grid divider, `<DividerLayer>` stamps
    // `.is-resizing` on the root `[data-dnd-root="true"]` element and clears
    // it on pointerup. ResizeObserver fires ~60Hz during the drag; firing
    // a tmux resize per tick triggers ~20 tmux composite repaints per drag,
    // each of which ships a full-screen redraw to xterm.js. Each repaint's
    // trailing `\r\n` at the bottom of the viewport pushes a line into
    // scrollback — the "flipbook of ghost frames" users saw.
    //
    // Strategy: during a drag, update xterm's internal dims locally (so the
    // viewport stays visually aligned with the container) but suppress the
    // tmux + PTY resize. When the drag ends, fire ONE resize with the
    // final dims. Net repaint count per drag: 1.
    const gridRoot = (host as HTMLElement).closest<HTMLElement>('[data-dnd-root="true"]');
    const isDragging = (): boolean => gridRoot?.classList.contains("is-resizing") ?? false;

    const fitLocalOnly = (): void => {
      if (!term || !fit) return;
      const shouldRepin = shouldAutoStickToBottomOnResize(props.kind) && isViewportAtBottom(term);
      try {
        fit.fit();
      } catch {
        /* xterm not laid out yet — harmless, retry next tick */
      }
      if (shouldRepin) scheduleResizeRepin(false);
    };

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        if (hasSpawned) {
          if (isDragging()) {
            // Keep xterm's buffer sized to the container so the user sees
            // smooth visual feedback during the drag, but hold off on the
            // tmux resize. MutationObserver below flushes it on drag-end.
            fitLocalOnly();
            resizePendingFromDrag = true;
            return;
          }
          scheduleResize();
          return;
        }
        if (persistedSessionId) {
          tryReattach();
        } else {
          trySpawn();
        }
      });
      resizeObserver.observe(host);
    }

    if (gridRoot && typeof MutationObserver !== "undefined") {
      gridMutationObserver = new MutationObserver(() => {
        // Class-attribute flips only; ignore if the drag is still active.
        if (gridRoot.classList.contains("is-resizing")) return;
        if (!resizePendingFromDrag) return;
        resizePendingFromDrag = false;
        // Drag just ended and we owe tmux a resize. Use the debounced
        // `scheduleResize` so a brief class-flip flurry (drag → snap →
        // divider reset, etc.) still collapses to one tmux round-trip.
        scheduleResize();
      });
      gridMutationObserver.observe(gridRoot, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }

    // After fonts load (or a 500 ms safety timeout), kick the first measurement.
    // `document.fonts.ready` never rejects but can stall indefinitely on
    // offline / blocked-font networks — the race keeps us responsive.
    const fontsReady: Promise<void> =
      typeof document !== "undefined" && document.fonts?.ready
        ? document.fonts.ready.then(
            () => undefined,
            () => undefined,
          )
        : Promise.resolve();
    const fontsTimeout = new Promise<void>((resolve) =>
      setTimeout(resolve, FONTS_READY_TIMEOUT_MS),
    );
    void Promise.race([fontsReady, fontsTimeout]).then(() => {
      requestAnimationFrame(() => {
        if (!term) return;
        if (persistedSessionId) {
          // Reattach path: open a new PTY-attached client against an
          // existing tmux session. Post-reattach the ResizeObserver pushes
          // a terminal_resize to match the current host dims if the
          // viewport changed since the previous run.
          tryReattach();
          scheduleResize();
        } else {
          trySpawn();
        }
      });
    });

    // §4.5 — per-keystroke input plumbing. Safe to attach before spawn:
    // `sessionId()` is null until spawn resolves, which short-circuits the
    // invoke.
    term.onData((chunk) => {
      const id = sessionId();
      if (!id) return;
      void invoke("terminal_send_keys", {
        sessionId: id,
        keys: chunk,
      }).catch((e) => {
        console.error("[TerminalPane] terminal_send_keys failed", e);
      });
    });

    // §4.2 — focus promotes to WebGL.
    term.textarea?.addEventListener("focus", () => {
      requestWebgl(paneId);
    });

    // Auto-copy on selection release (Zellij-style). Fires on mouseup so a
    // mid-drag selection doesn't clobber the clipboard, and on Shift keyup so
    // keyboard-driven selections are covered too.
    //
    // We listen for mouseup on `window`, not `host`, because a selection that
    // starts inside the pane often ends outside it — e.g. dragging bottom-to-top
    // the cursor crosses the top edge of the pane before release. A flag set on
    // mousedown-inside-host scopes the window listener to drags owned by this
    // pane so other panes' mouseups don't trigger a spurious copy here.
    const copySelection = async (): Promise<void> => {
      if (!term || !term.hasSelection()) return;
      const text = term.getSelection();
      if (!text || text.trim().length === 0) return;
      try {
        if (!navigator.clipboard?.writeText) return;
        await navigator.clipboard.writeText(text);
      } catch {
        return;
      }
      setCopiedFlash(true);
      if (copyFlashTimer !== null) clearTimeout(copyFlashTimer);
      copyFlashTimer = setTimeout(() => {
        copyFlashTimer = null;
        setCopiedFlash(false);
      }, COPY_FLASH_MS);
    };
    let dragActive = false;
    const onMouseDown = (): void => {
      dragActive = true;
    };
    const onWindowMouseUp = (): void => {
      if (!dragActive) return;
      dragActive = false;
      void copySelection();
    };
    const onKeyUp = (ev: KeyboardEvent): void => {
      if (ev.key !== "Shift") return;
      void copySelection();
    };
    host.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onWindowMouseUp);
    term.textarea?.addEventListener("keyup", onKeyUp);
    onCleanup(() => {
      host?.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onWindowMouseUp);
    });

    // §4.7 — register with the global search registry.
    createEffect(() => {
      if (!term || !search) return;
      registerTerminal({
        paneId,
        sessionId: sessionId(),
        kind: props.kind,
        projectSlug: props.projectSlug ?? null,
        worktreeId: props.worktreeId ?? null,
        terminal: term,
        search,
        revealBufferLine: (buffer: TerminalBufferKind, row: number) => {
          if (!term) return;
          if (buffer === "normal" && term.buffer.active.type === "alternate") {
            openHistoryOverlay(row);
            return;
          }
          setHistoryOverlay(null);
          term.scrollToLine(row);
        },
        focus: () => {
          try {
            host?.scrollIntoView({ block: "nearest", inline: "nearest" });
          } catch {
            /* non-fatal */
          }
          term?.focus();
        },
      });
    });
  });

  onCleanup(() => {
    unlistenProcessExited?.();
    unsubscribeTheme?.();
    unsubscribeTheme = null;
    unregisterTerminal(paneId);
    unregisterPane(paneId);
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    if (copyFlashTimer !== null) {
      clearTimeout(copyFlashTimer);
      copyFlashTimer = null;
    }
    clearResizeRepin();
    try {
      resizeObserver?.disconnect();
    } catch {
      /* best-effort */
    }
    try {
      gridMutationObserver?.disconnect();
    } catch {
      /* best-effort */
    }
    try {
      fit?.dispose();
    } catch {
      /* best-effort */
    }
    try {
      search?.dispose();
    } catch {
      /* best-effort */
    }
    try {
      scrollDisposable?.dispose();
    } catch {
      /* best-effort */
    }
    try {
      term?.dispose();
    } catch {
      /* best-effort */
    }
    // The Tauri Channel has no explicit dispose; dropping references is
    // sufficient. Nulling xterm handles here makes leaks observable in tests.
    term = null;
    fit = null;
    search = null;
    scrollDisposable = null;
  });

  return (
    <div
      class="terminal-pane-shell relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-lg"
      classList={{ "ring-2 ring-inset ring-foreground/30": dropTargetPaneId() === paneId }}
      style={{ border: `2px solid ${borderColor()}` }}
      data-pane-id={paneId}
      data-session-id={sessionId() ?? ""}
      data-testid="terminal-pane"
    >
      <div
        ref={(el) => {
          host = el;
        }}
        class="min-h-0 min-w-0 flex-1 overflow-hidden"
      />
      <Show when={hasDetachedHistory()}>
        <button
          type="button"
          onClick={() => openHistoryOverlay()}
          class="absolute top-3 left-3 z-20 rounded-full border border-border-strong bg-popover px-2.5 py-1 text-[11px] font-medium text-foreground shadow-[var(--shadow-md)] transition-colors hover:bg-hover"
          title="Browse preserved history"
        >
          History
        </button>
      </Show>
      <div
        class="pointer-events-none absolute top-2 right-2 z-20 flex items-center gap-1 rounded-md bg-foreground/95 px-2 py-1 text-[11px] font-medium text-background shadow-[var(--shadow-sm)] transition-opacity duration-150"
        classList={{ "opacity-100": copiedFlash(), "opacity-0": !copiedFlash() }}
        aria-hidden={!copiedFlash()}
      >
        <CopyIcon class="h-3.5 w-3.5" />
        <span>Copied</span>
      </div>
      <Show when={isScrolledUp()}>
        <button
          type="button"
          onClick={() => {
            term?.scrollToBottom();
            setIsScrolledUp(false);
          }}
          class="group absolute right-3 bottom-3 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-popover text-foreground shadow-[var(--shadow-md)] transition-[transform,box-shadow,background-color] duration-200 ease-out hover:-translate-y-0.5 hover:bg-hover hover:shadow-[var(--shadow-lg),0_0_18px_-4px_color-mix(in_oklab,var(--project-accent,var(--foreground))_45%,transparent)] focus:outline-none focus-visible:shadow-[var(--shadow-lg),0_0_0_2px_color-mix(in_oklab,var(--project-accent,var(--foreground))_70%,transparent)]"
          aria-label="Scroll to bottom"
          title="Scroll to bottom"
        >
          <span
            class="pointer-events-none absolute inset-0 rounded-full bg-[radial-gradient(circle_at_50%_20%,color-mix(in_oklab,var(--foreground)_22%,transparent),transparent_70%)]"
            aria-hidden="true"
          />
          <ChevronDownIcon class="relative h-4 w-4 transition-transform duration-200 ease-out group-hover:translate-y-0.5" />
        </button>
      </Show>
      {errorMsg() ? (
        <div class="border-t border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {errorMsg()}
        </div>
      ) : null}
      <Show when={historyOverlay()}>
        {(overlay) => (
          <div class="absolute inset-0 z-30 flex flex-col bg-scrim-strong">
            <div class="flex items-center justify-between border-b border-border px-3 py-2">
              <div class="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Preserved History
              </div>
              <button
                type="button"
                onClick={() => setHistoryOverlay(null)}
                class="focus-ring rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground hover:bg-hover"
              >
                Close
              </button>
            </div>
            <div
              ref={(el) => {
                historyViewport = el;
              }}
              class="min-h-0 flex-1 overflow-auto px-3 py-3"
            >
              <div class="space-y-0.5 font-mono text-xs text-foreground">
                <For each={overlay().lines}>
                  {(line, index) => (
                    <div
                      data-history-row={index()}
                      class="grid grid-cols-[4rem_minmax(0,1fr)] gap-3 rounded px-2 py-0.5"
                      classList={{
                        "bg-active text-foreground": overlay().highlightRow === index(),
                        "text-foreground-dim": line.length === 0,
                      }}
                    >
                      <span class="select-none text-right text-[10px] text-foreground-subtle">
                        {index()}
                      </span>
                      <span class="whitespace-pre-wrap break-words">
                        {line.length > 0 ? line : "\u00a0"}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>
        )}
      </Show>
      <Show when={exitState()}>
        <button
          type="button"
          class="absolute inset-0 z-10 flex cursor-pointer items-center justify-center bg-scrim"
          onClick={() => props.onRequestClose?.()}
        >
          <span class="select-none font-mono text-sm text-muted-foreground">
            exited: {exitState()!.code}
          </span>
        </button>
      </Show>
    </div>
  );
};

export default TerminalPane;
