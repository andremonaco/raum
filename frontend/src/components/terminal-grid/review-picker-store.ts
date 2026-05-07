import { createSignal } from "solid-js";

import { type ReviewSpawnPayload } from "./types";

/**
 * Cross-harness review picker: transient state set by `startReviewFromDrop`
 * after `prepare_review` resolves and consumed by `<ReviewPickerOverlay>`.
 *
 * Keyed on the *target* cell id (= where the reviewer pane will be spawned)
 * so the overlay can mount inside that cell's `LeafFrame` and inherit its
 * container query for sizing. The reviewer's harness kind comes from
 * `payload.reviewerKind` — that's what the picker shows models for.
 *
 * Lifecycle: set by `startReviewFromDrop`, cleared by either
 * `confirmReviewPicker` (after firing `spawnReviewerPane`) or
 * `cancelReviewPicker` (on Esc / outside-click).
 */
export interface PendingReviewPicker {
  targetCellId: string;
  payload: ReviewSpawnPayload;
}

const [pendingReviewPicker, setPendingReviewPicker] = createSignal<PendingReviewPicker | null>(
  null,
);

export { pendingReviewPicker };

/**
 * Monotonically increasing counter bumped whenever the picker state is
 * mutated (set or cleared). The spawn path snapshots this *before*
 * `await invoke("prepare_review")` and re-checks after — if it has
 * advanced, the user has cancelled (or another drop superseded), and the
 * stale response must NOT resurrect the dismissed picker. Plain mutable
 * state, not a Solid signal: no component renders this value.
 */
let generation = 0;

export function currentGeneration(): number {
  return generation;
}

export function setReviewPickerPending(p: PendingReviewPicker): void {
  generation += 1;
  setPendingReviewPicker(p);
}

export function clearReviewPicker(): void {
  generation += 1;
  setPendingReviewPicker(null);
}
