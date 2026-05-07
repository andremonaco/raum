/**
 * §9 — sidebar tunables. Kept tiny and side-effect free so any module in the
 * folder can import these without pulling in JSX or stores.
 */

// §9.1 — polling cadence. Debounced per-worktree: each expanded row owns its
// own interval so collapsing a row stops its poll immediately.
export const STATUS_POLL_MS = 2_000;

// §9.7 — clamp matches the backend (160..800). Duplicated here so the handle
// snaps predictably during the drag without waiting for the invoke round-trip.
export const SIDEBAR_MIN_PX = 160;
export const SIDEBAR_MAX_PX = 800;
// Wide enough to hold three size-2.5 icons (10 px each) + two gap-0.5 gaps
// (2 px each) + minimal padding on either side = 34 px content + ~10 px room.
export const SIDEBAR_COLLAPSED_PX = 44;
