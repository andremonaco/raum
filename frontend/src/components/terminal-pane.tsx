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
  Show,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
} from "solid-js";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";

import type { AgentKind } from "../lib/agentKind";
import { registerPane, requestWebgl, unregisterPane } from "../lib/rendererScheduler";
import { registerTerminal, unregisterTerminal } from "../lib/terminalRegistry";
import { CopyIcon } from "./icons";

/** xterm.js scrollback cap (§3.8 / §4.1). Mirrors `XTERM_SCROLLBACK` in Rust. */
export const XTERM_SCROLLBACK_LINES = 10_000;

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
  projectSlug?: string;
  worktreeId?: string;
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

/** Upper bound before we give up waiting for `document.fonts.ready`. */
const FONTS_READY_TIMEOUT_MS = 500;

/** Duration the "Copied" flash stays visible after an auto-copy (ms). */
const COPY_FLASH_MS = 900;

export const TerminalPane: Component<TerminalPaneProps> = (props) => {
  const paneId = createUniqueId();
  let host: HTMLDivElement | undefined;

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

  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let search: SearchAddon | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let copyFlashTimer: ReturnType<typeof setTimeout> | null = null;

  onMount(() => {
    if (!host) return;

    try {
      term = new Terminal({
        scrollback: XTERM_SCROLLBACK_LINES,
        fontFamily: '"JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace',
        fontSize: 13,
        cursorBlink: true,
        allowProposedApi: true,
        theme: {
          background: "#09090b",
        },
      });
      fit = new FitAddon();
      search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);

      term.open(host);
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
      void invoke("terminal_resize", {
        sessionId: id,
        cols: term.cols,
        rows: term.rows,
      }).catch((e) => {
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

    // §4.1 — gated spawn. Harnesses (Ink-based TUIs) paint their banner into
    // the MAIN screen buffer and re-paint on SIGWINCH, so spawning at the wrong
    // size and then resizing produces a stacked, glitchy banner. Wait until we
    // have real fitted dims before the backend creates the tmux session.
    const isReattach = !!props.sessionId;
    let hasSpawned = isReattach;
    if (isReattach) setSessionId(props.sessionId!);

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
        projectSlug: props.projectSlug,
        worktreeId: props.worktreeId,
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
    // it debounces resize pushes. Solid's ref assignment has already run by
    // the time onMount fires, so `host` is guaranteed non-null here.
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        if (!hasSpawned) {
          trySpawn();
        } else {
          scheduleResize();
        }
      });
      resizeObserver.observe(host);
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
        if (isReattach) {
          // Reattach path: session already exists, just make sure tmux sees
          // the current host size. Debounced so overlapping observer ticks
          // coalesce.
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
    const onMouseUp = (): void => {
      void copySelection();
    };
    const onKeyUp = (ev: KeyboardEvent): void => {
      if (ev.key !== "Shift") return;
      void copySelection();
    };
    host.addEventListener("mouseup", onMouseUp);
    term.textarea?.addEventListener("keyup", onKeyUp);

    // §4.7 — register with the global search registry.
    registerTerminal({
      paneId,
      sessionId: sessionId(),
      kind: props.kind,
      projectSlug: props.projectSlug ?? null,
      worktreeId: props.worktreeId ?? null,
      terminal: term,
      search,
      scrollToLine: (row: number) => {
        term?.scrollToLine(row);
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

  onCleanup(() => {
    unlistenProcessExited?.();
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
    try {
      resizeObserver?.disconnect();
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
      term?.dispose();
    } catch {
      /* best-effort */
    }
    // The Tauri Channel has no explicit dispose; dropping references is
    // sufficient. Nulling xterm handles here makes leaks observable in tests.
    term = null;
    fit = null;
    search = null;
  });

  return (
    <div
      class="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-lg bg-zinc-950"
      style={{ border: `2px solid ${borderColor()}` }}
      data-pane-id={paneId}
      data-testid="terminal-pane"
    >
      <div ref={(el) => (host = el)} class="min-h-0 min-w-0 flex-1 overflow-hidden" />
      <div
        class="pointer-events-none absolute top-2 right-2 z-20 flex items-center gap-1 rounded-md bg-zinc-100/95 px-2 py-1 text-[11px] font-medium text-zinc-900 shadow-md transition-opacity duration-150"
        classList={{ "opacity-100": copiedFlash(), "opacity-0": !copiedFlash() }}
        aria-hidden={!copiedFlash()}
      >
        <CopyIcon class="h-3.5 w-3.5" />
        <span>Copied</span>
      </div>
      {errorMsg() ? (
        <div class="border-t border-red-800 bg-red-950/60 px-2 py-1 text-[11px] text-red-300">
          {errorMsg()}
        </div>
      ) : null}
      <Show when={exitState()}>
        <div
          class="absolute inset-0 z-10 flex cursor-pointer items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => props.onRequestClose?.()}
        >
          <span class="select-none font-mono text-sm text-zinc-400">
            exited: {exitState()!.code}
          </span>
        </div>
      </Show>
    </div>
  );
};

export default TerminalPane;
