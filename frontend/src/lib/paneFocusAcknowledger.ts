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
 * The state read is wrapped in `untrack` — without it, Solid would
 * re-run this effect on every state change, so a completion that
 * arrives while the user is already focused on the pane would
 * acknowledge itself instantly and the green chrome would never paint.
 * Focus-transition is the only signal we want to react to here; the
 * "already-focused, click again" case is handled by explicit
 * acknowledge calls inside `claimFocus` / `onFocusCapture`.
 */
import { createEffect, untrack } from "solid-js";

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
    const state = untrack(() => agentStore.sessions[sessionId]?.state);
    if (state === "completed" || state === "errored") {
      markAcknowledged(sessionId);
    }
  });
}
