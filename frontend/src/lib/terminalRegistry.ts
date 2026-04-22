/**
 * §4.7 — Terminal registry used by the spotlight dock's scrollback search
 * to iterate every mounted xterm.js buffer. `<TerminalPane>` registers on
 * mount and unregisters on unmount. Kept deliberately framework-free: no
 * Solid signals here because the search materialises the set lazily when
 * invoked, not reactively.
 */

import type { IBuffer, Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import type { AgentKind } from "./agentKind";

export type TerminalBufferKind = "normal" | "alternate";

export interface RegisteredTerminalBuffer {
  kind: TerminalBufferKind;
  active: boolean;
  buffer: IBuffer;
}

export interface RegisteredTerminal {
  paneId: string;
  sessionId: string | null;
  kind: AgentKind;
  projectSlug: string | null;
  worktreeId: string | null;
  terminal: Terminal;
  search: SearchAddon;
  /** Reveal a match in the chosen xterm.js buffer. */
  revealBufferLine: (buffer: TerminalBufferKind, row: number) => void;
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

export function listTerminalBuffers(terminal: Terminal): RegisteredTerminalBuffer[] {
  const active = terminal.buffer.active;
  const normal = terminal.buffer.normal;
  const views: RegisteredTerminalBuffer[] = [
    {
      kind: "normal",
      active: active.type === "normal",
      buffer: normal,
    },
  ];
  if (active.type === "alternate") {
    views.push({
      kind: "alternate",
      active: true,
      buffer: active,
    });
  }
  return views;
}

/** Test-only helper: wipe the registry between tests. Not exported from the
 * lib barrel. */
export function __clearRegistryForTests(): void {
  entries.clear();
}
