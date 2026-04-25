import { invoke } from "@tauri-apps/api/core";
import {
  setTerminalPaneContexts,
  terminalStore,
  type TerminalPaneContext,
} from "../stores/terminalStore";

const SHELL_CONTEXT_POLL_MS = 2_000;

function shellSessionIds(): string[] {
  return Object.values(terminalStore.byId)
    .filter((terminal) => terminal.kind === "shell")
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

  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}
