/**
 * Resolve the user-facing tab label for a harness session.
 *
 * Mirrors what `TabItem` in `terminal-grid.tsx` renders so other surfaces
 * (spotlight dock, scrollback search) show the same string the user sees
 * in the tab strip — never the raw tmux session id.
 *
 * Lookup order:
 *   1. User-chosen `CellTab.label` in the layout.
 *   2. Layout-polled `CellTab.autoLabel`.
 *   3. `resolveHarnessAutoLabel` on the stored paneContext (for sessions
 *      that exist in `terminalStore` but aren't mounted in the grid).
 *   4. `kindDisplayLabel(kind)` as a last resort.
 */

import { kindDisplayLabel, type AgentKind } from "./agentKind";
import { resolveHarnessAutoLabel } from "./terminalTabLabel";
import { runtimeLayoutStore } from "../stores/runtimeLayoutStore";
import { terminalStore } from "../stores/terminalStore";

function normalize(value: string | null | undefined): string | undefined {
  const cleaned = value?.replace(/[\r\n\t]+/g, " ").trim();
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}

function findLayoutLabel(sessionId: string): string | undefined {
  for (const pane of Object.values(runtimeLayoutStore.panes)) {
    for (const tab of pane.tabs) {
      if (tab.sessionId !== sessionId) continue;
      return normalize(tab.label) ?? normalize(tab.autoLabel);
    }
  }
  return undefined;
}

export function resolveSessionTabLabel(sessionId: string): string {
  const layoutLabel = findLayoutLabel(sessionId);
  if (layoutLabel) return layoutLabel;

  const record = terminalStore.byId[sessionId];
  if (record) {
    const auto = resolveHarnessAutoLabel({
      kind: record.kind,
      paneTitle: record.paneContext?.paneTitle,
      windowName: record.paneContext?.windowName,
      currentCommand: record.paneContext?.currentCommand,
    });
    const cleaned = normalize(auto);
    if (cleaned) return cleaned;
    return kindDisplayLabel(record.kind);
  }

  return kindDisplayLabel("shell" satisfies AgentKind);
}
