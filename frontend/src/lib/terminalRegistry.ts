/**
 * §4.7 — Terminal registry used by `<GlobalSearchPanel>` to iterate every
 * mounted xterm.js buffer. `<TerminalPane>` registers on mount and unregisters
 * on unmount. Kept deliberately framework-free: no Solid signals here because
 * the search panel materializes the set lazily when invoked, not reactively.
 */

import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import type { AgentKind } from "./agentKind";

export interface RegisteredTerminal {
  paneId: string;
  sessionId: string | null;
  kind: AgentKind;
  projectSlug: string | null;
  worktreeId: string | null;
  terminal: Terminal;
  search: SearchAddon;
  /** Scroll to a given 0-based row index in the xterm.js buffer. */
  scrollToLine: (row: number) => void;
  /** Move focus to the pane and its xterm.js textarea. */
  focus: () => void;
}

const entries = new Map<string, RegisteredTerminal>();

export function registerTerminal(entry: RegisteredTerminal): void {
  entries.set(entry.paneId, entry);
}

export function unregisterTerminal(paneId: string): void {
  entries.delete(paneId);
}

export function listTerminals(): RegisteredTerminal[] {
  return Array.from(entries.values());
}

export function getTerminal(paneId: string): RegisteredTerminal | undefined {
  return entries.get(paneId);
}

/** Test-only helper: wipe the registry between tests. Not exported from the
 * lib barrel. */
export function __clearRegistryForTests(): void {
  entries.clear();
}
