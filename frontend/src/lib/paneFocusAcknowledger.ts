/**
 * Bridges pane focus → agent-session acknowledgement.
 *
 * When the user focuses a pane AND the focused pane's active tab points
 * at a harness session in a terminal state (`completed` / `errored`),
 * implicitly mark that session as "read" via {@link markAcknowledged}.
 * That clears the tab's green "unread" chrome and pane-level dot. A
 * subsequent transition back through `working` / `idle` in
 * `updateSessionState` automatically re-arms the unread state, so the
 * next completion lights the tab up again.
 *
 * Defining "viewed" as `focusedPaneId === cellId && pane.activeTabId
 * resolves to this session` matches the email-unread feel the user asked
 * for: just focusing a neighbouring pane, or sitting on a different tab
 * inside the same pane, does not clear the marker.
 */
import { createEffect } from "solid-js";

import { agentStore, markAcknowledged } from "../stores/agentStore";
import { focusedPaneId, runtimeLayoutStore } from "../stores/runtimeLayoutStore";

export function installPaneFocusAcknowledger(): void {
  createEffect(() => {
    const cellId = focusedPaneId();
    if (!cellId) return;
    const pane = runtimeLayoutStore.panes[cellId];
    if (!pane) return;
    const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
    const sessionId = activeTab?.sessionId;
    if (!sessionId) return;
    const state = agentStore.sessions[sessionId]?.state;
    if (state === "completed" || state === "errored") {
      markAcknowledged(sessionId);
    }
  });
}
