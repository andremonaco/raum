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
 * hit-test the cursor against the rendered pane shells. Webview/OS pairs
 * disagree on whether `position` is already in CSS pixels or needs a
 * devicePixelRatio conversion, so we first try the raw point and only fall
 * back to DPR-scaled coordinates if raw misses every pane. We iterate the actual
 * `[data-pane-id][data-session-id]` shells and pick the one whose rect
 * contains the cursor — `elementFromPoint` + `closest()` is unreliable
 * here because xterm's canvas/textarea, surface-frame chrome, and
 * absolutely-positioned overlays (snap, exit dialog, history) often sit
 * between the cursor and the pane shell, causing the closest-walk to land
 * on a sibling or an outer frame that lacks `data-pane-id`.
 *
 * HTML5 DnD listeners don't work reliably on the xterm.js surface either,
 * which is why we use the OS-level Tauri path.
 */

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { terminalStore } from "../stores/terminalStore";
import type { AgentKind } from "../stores/agentStore";

const [dropTargetPaneId, setDropTargetPaneId] = createSignal<string | null>(null);
const [dropPreviewPaths, setDropPreviewPaths] = createSignal<string[]>([]);
export { dropTargetPaneId, dropPreviewPaths };

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

export interface PaneHit {
  paneId: string;
  sessionId: string;
}

interface LogicalPoint {
  x: number;
  y: number;
}

function isVisiblePaneShell(shell: HTMLElement): boolean {
  for (let el: HTMLElement | null = shell; el; el = el.parentElement) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
  }
  return true;
}

function paneUnderLogicalCursor(point: LogicalPoint): PaneHit | null {
  const shells = document.querySelectorAll<HTMLElement>("[data-pane-id][data-session-id]");
  let hit: PaneHit | null = null;
  for (const shell of shells) {
    const sessionId = shell.dataset.sessionId ?? "";
    const paneId = shell.dataset.paneId ?? "";
    if (!sessionId || !paneId) continue;
    if (!isVisiblePaneShell(shell)) continue;
    const rect = shell.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (
      point.x < rect.left ||
      point.x >= rect.right ||
      point.y < rect.top ||
      point.y >= rect.bottom
    ) {
      continue;
    }
    hit = { paneId, sessionId };
  }
  return hit;
}

/** Geometric hit-test against pane shells. Iterates every mounted
 *  `[data-pane-id][data-session-id]` shell and picks the one whose
 *  bounding rect contains the cursor. If multiple rects overlap (e.g. a
 *  cross-review snap overlay), the last one in DOM order wins — that
 *  matches paint order and matches what the user visually sees on top.
 *  Exported for tests. */
export function paneUnderCursor(physicalX: number, physicalY: number): PaneHit | null {
  const raw = paneUnderLogicalCursor({ x: physicalX, y: physicalY });
  if (raw) return raw;

  const dpr = window.devicePixelRatio || 1;
  if (dpr === 1) return null;
  return paneUnderLogicalCursor({ x: physicalX / dpr, y: physicalY / dpr });
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
          setDropPreviewPaths([]);
          return;
        }
        setDropPreviewPaths(payload.paths);
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
        setDropPreviewPaths([]);
        return;
      }
      case "drop": {
        setDropTargetPaneId(null);
        setDropPreviewPaths([]);
        if (payload.paths.length === 0) return;
        const hit = paneUnderCursor(payload.position.x, payload.position.y);
        if (!hit) return;
        const kind = terminalStore.byId[hit.sessionId]?.kind;
        const mode = pasteModeForKind(kind);
        window.dispatchEvent(
          new CustomEvent("terminal-focus-requested", {
            detail: { sessionId: hit.sessionId },
          }),
        );
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
