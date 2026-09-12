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

/** The running poller's tick, so the window-activation coordinator can ask
 *  for one refresh right after a return without owning a second listener.
 *  The tick dedupes itself (`inFlight`) and skips while hidden. */
let activeTick: (() => void) | null = null;

/** Refresh shell labels now (no-op when no poller is running). */
export function pollShellContextNow(): void {
  activeTick?.();
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

  // The re-show refresh is driven by `windowActivation`'s after-usable
  // callback (via `pollShellContextNow`), so it lands after the first usable
  // frame instead of competing with it.
  activeTick = () => void tick();

  return () => {
    stopped = true;
    activeTick = null;
    window.clearInterval(timer);
  };
}
