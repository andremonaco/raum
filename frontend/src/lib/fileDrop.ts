/**
 * OS-level file drag-and-drop into terminal panes.
 *
 * Delivers dropped paths as a *paste event* (via tmux `load-buffer` +
 * `paste-buffer -p`) rather than as raw keystrokes. That gives two things
 * the previous `send-keys` path couldn't:
 *   1. Bracketed-paste wrapping (`ESC[200~ … ESC[201~`) is emitted by tmux
 *      *iff* the pane's foreground app has enabled DECSET 2004. Claude Code,
 *      Codex, OpenCode and `vim` insert-mode all use that signal to treat
 *      the payload as an attachment / paste rather than a run of keystrokes.
 *   2. The payload itself is not shell-escaped when the pane is running a
 *      harness — backslash-space and surrounding quotes would otherwise be
 *      inserted literally into the harness's prompt parser
 *      (anthropics/claude-code #16532, #4705).
 *
 * Pane resolution: the Tauri v2 drag-drop event is window-global, so we
 * hit-test the cursor against `[data-session-id]` elements. `position`
 * arrives in physical pixels; we divide by devicePixelRatio before
 * `elementFromPoint`. HTML5 DnD listeners don't work reliably on the
 * xterm.js surface (hidden textarea + shadow DOM), which is why we use
 * the OS-level Tauri path.
 */

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { terminalStore } from "../stores/terminalStore";
import type { AgentKind } from "../stores/agentStore";

const [dropTargetPaneId, setDropTargetPaneId] = createSignal<string | null>(null);
export { dropTargetPaneId };

export type PasteMode = "harness" | "shell";

/** Map the pane's agent kind to the paste mode the backend expects.
 *  Harnesses (Claude Code / Codex / OpenCode) parse the bracketed paste as
 *  an attachment list; shells and unknown panes want POSIX-quoted paths. */
export function pasteModeForKind(kind: AgentKind | undefined): PasteMode {
  if (kind === "claude-code" || kind === "codex" || kind === "opencode") {
    return "harness";
  }
  return "shell";
}

interface PaneHit {
  paneId: string;
  sessionId: string;
}

function paneUnderCursor(physicalX: number, physicalY: number): PaneHit | null {
  const dpr = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(physicalX / dpr, physicalY / dpr);
  if (!el) return null;
  const shell = el.closest<HTMLElement>("[data-session-id]");
  if (!shell) return null;
  const sessionId = shell.dataset.sessionId ?? "";
  const paneId = shell.dataset.paneId ?? "";
  if (!sessionId || !paneId) return null;
  return { paneId, sessionId };
}

/** Install the window-level drag-drop handler. Resolves to an unsubscribe
 *  function; callers may discard it at app scope (the listener lives for
 *  the life of the webview). */
export async function installFileDrop(): Promise<() => void> {
  const webview = getCurrentWebview();
  const unlisten = await webview.onDragDropEvent((event) => {
    const payload = event.payload;
    switch (payload.type) {
      case "enter": {
        // Empty `paths` means the drag has no files (e.g. a text-only drag
        // from a webpage) — nothing to insert, so no highlight either.
        if (payload.paths.length === 0) {
          setDropTargetPaneId(null);
          return;
        }
        const hit = paneUnderCursor(payload.position.x, payload.position.y);
        setDropTargetPaneId(hit?.paneId ?? null);
        return;
      }
      case "over": {
        const hit = paneUnderCursor(payload.position.x, payload.position.y);
        setDropTargetPaneId(hit?.paneId ?? null);
        return;
      }
      case "leave": {
        setDropTargetPaneId(null);
        return;
      }
      case "drop": {
        setDropTargetPaneId(null);
        if (payload.paths.length === 0) return;
        const hit = paneUnderCursor(payload.position.x, payload.position.y);
        if (!hit) return;
        const kind = terminalStore.byId[hit.sessionId]?.kind;
        const mode = pasteModeForKind(kind);
        void invoke("terminal_paste_paths", {
          sessionId: hit.sessionId,
          paths: payload.paths,
          mode,
        }).catch((e) => {
          console.error("[fileDrop] terminal_paste_paths failed", e);
        });
        return;
      }
    }
  });
  return unlisten;
}
