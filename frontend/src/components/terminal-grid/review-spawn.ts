import { invoke } from "@tauri-apps/api/core";

import {
  clearTabReviewPending,
  runtimeLayoutStore,
  tabPendingReviewOf,
} from "../../stores/runtimeLayoutStore";
import { currentGeneration, setReviewPickerPending } from "./review-picker-store";
import { type ReviewSpawnPayload } from "./types";

export type { ReviewSpawnPayload } from "./types";

export function activeSessionForCell(cellId: string): string | undefined {
  const pane = runtimeLayoutStore.panes[cellId];
  if (!pane) return undefined;
  return pane.tabs.find((t) => t.id === pane.activeTabId)?.sessionId;
}

/**
 * Cross-harness review: kick off a review when the user drops the source
 * pane onto a sibling pane. Resolves the active sessions, asks the backend
 * to render the brief, then **opens the model picker** anchored to the
 * target pane. Confirmation in the picker spawns the reviewer pane (via
 * `<ReviewPickerOverlay>` calling `spawnReviewerPane`); cancellation drops
 * the review entirely without leaving artefacts.
 *
 * The source pane is left untouched — it only contributes its harness
 * *kind* (so the reviewer is the same flavour the user dragged); its
 * session keeps running in its slot.
 *
 * `<TerminalPane>` ultimately spawns the new harness because the new pane's
 * tab has no `sessionId` and carries `initialPrompt` (the brief) plus the
 * picker's `modelOverride`. After spawn, `consumeReviewSpawn` fires
 * `record_review_link` so both panes show as linked.
 */
export async function startReviewFromDrop(
  sourceCellId: string,
  targetCellId: string,
): Promise<void> {
  const reviewerSessionId = activeSessionForCell(sourceCellId);
  const reviewedSessionId = activeSessionForCell(targetCellId);
  if (!reviewerSessionId || !reviewedSessionId) {
    console.warn("[review] missing session id on source or target cell", {
      sourceCellId,
      targetCellId,
    });
    return;
  }
  if (reviewerSessionId === reviewedSessionId) return;

  // Snapshot the picker-store generation BEFORE the IPC. If the user
  // dismisses the picker (Cancel / Escape / outside-click) while
  // `prepare_review` is in flight, `clearReviewPicker` bumps the
  // counter; we must NOT then turn around and resurrect the picker
  // when our stale response lands. Same guard catches the case where
  // a second drop supersedes ours mid-flight.
  const myGen = currentGeneration();

  let payload: ReviewSpawnPayload;
  try {
    payload = await invoke<ReviewSpawnPayload>("prepare_review", {
      args: { reviewerSessionId, reviewedSessionId },
    });
  } catch (e) {
    console.warn("[review] prepare_review failed", e);
    return;
  }
  if (myGen !== currentGeneration()) {
    console.debug("[review] dropping stale prepare_review response (picker dismissed)");
    return;
  }
  if (!runtimeLayoutStore.panes[targetCellId]) {
    console.warn("[review] target pane went away before picker could show");
    return;
  }
  setReviewPickerPending({ targetCellId, payload });
}

/**
 * Called from `<TerminalPane>`'s `onSpawned` callback. If the tab was
 * created as a reviewer pane (has `pendingReviewOf`), tells the backend to
 * record the link and clears the pending fields so a later respawn doesn't
 * re-link.
 */
export function consumeReviewSpawn(
  cellId: string | undefined,
  tabId: string | undefined,
  newSessionId: string,
): void {
  if (!cellId || !tabId) return;
  const reviewedSessionId = tabPendingReviewOf(cellId, tabId);
  if (!reviewedSessionId) {
    console.debug("[review] consumeReviewSpawn: no pendingReviewOf on tab", {
      cellId,
      tabId,
      newSessionId,
    });
    return;
  }
  console.info("[review] recording link", {
    reviewerSessionId: newSessionId,
    reviewedSessionId,
  });
  void invoke("record_review_link", {
    args: {
      reviewerSessionId: newSessionId,
      reviewedSessionId,
    },
  }).catch((e: unknown) => {
    console.warn("[review] record_review_link failed", e);
  });
  clearTabReviewPending(cellId, tabId);
}
