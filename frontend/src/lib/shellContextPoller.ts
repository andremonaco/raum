import { invoke } from "@tauri-apps/api/core";
import { activeProjectSlug } from "../stores/projectStore";
import {
  setTerminalPaneContexts,
  terminalStore,
  type TerminalPaneContext,
} from "../stores/terminalStore";

const SHELL_CONTEXT_POLL_MS = 2_000;

/** Shells of the ACTIVE project only — the labels of a backgrounded project's
 *  shells are off screen, and each id costs a tmux round-trip per tick
 *  (live-watch is active-project-scoped app-wide). Project-less shells stay
 *  included: nothing else would ever refresh them. */
function shellSessionIds(): string[] {
  const slug = activeProjectSlug();
  return Object.values(terminalStore.byId)
    .filter(
      (terminal) =>
        terminal.kind === "shell" &&
        (terminal.project_slug === null || terminal.project_slug === slug),
    )
    .map((terminal) => terminal.session_id);
}

async function fetchBatch(sessionIds: string[]): Promise<Record<string, TerminalPaneContext>> {
  return invoke<Record<string, TerminalPaneContext>>("terminal_pane_context_batch", {
    sessionIds,
  });
}

async function fetchIndividually(
  sessionIds: string[],
): Promise<Record<string, TerminalPaneContext>> {
  const entries = await Promise.all(
    sessionIds.map(async (sessionId) => {
      const context = await invoke<TerminalPaneContext>("terminal_pane_context", { sessionId });
      return [sessionId, context] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function startShellContextPoller(): () => void {
  let stopped = false;
  let inFlight = false;
  let batchUnavailable = false;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    // Nothing reads shell labels while the window is hidden, and the tick is a
    // per-shell tmux round-trip — skip it and pick up on the next visible tick.
    if (typeof document !== "undefined" && document.hidden) return;
    const sessionIds = shellSessionIds();
    if (sessionIds.length === 0) return;

    inFlight = true;
    try {
      if (!batchUnavailable) {
        try {
          setTerminalPaneContexts(await fetchBatch(sessionIds));
          return;
        } catch {
          batchUnavailable = true;
        }
      }
      try {
        setTerminalPaneContexts(await fetchIndividually(sessionIds));
      } catch {
        /* non-fatal: shell labels keep their previous value */
      }
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = window.setInterval(() => {
    void tick();
  }, SHELL_CONTEXT_POLL_MS);

  // Refresh immediately on re-show so the labels aren't up to one poll window
  // stale after the ticks that were skipped while hidden.
  const onVisibilityChange = (): void => {
    if (!document.hidden) void tick();
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  return () => {
    stopped = true;
    window.clearInterval(timer);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}
