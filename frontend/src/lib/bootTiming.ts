import { invoke } from "@tauri-apps/api/core";

/**
 * Boot phase marks. Each phase is reported once, as `boot:<phase>` with the
 * webview-relative `performance.now()` offset, through the existing
 * `webview_wake_report` log line so startup ("first-interactive") and
 * recovery ("restore-complete" minus "gate-released") are readable from the
 * daily log next to the backend's `boot:` lines.
 */
const reported = new Set<string>();

export function markBoot(
  phase: "layout-hydrated" | "gate-released" | "first-interactive" | "restore-complete",
): void {
  if (reported.has(phase)) return;
  reported.add(phase);
  const ms = Math.max(0, Math.round(performance.now()));
  void Promise.resolve()
    .then(() => invoke("webview_wake_report", { phase: `boot:${phase}`, ms }))
    .catch(() => {});
}

// Persisted panes still working on their first attach. `restore-complete`
// fires when the count returns to zero after at least one registration.
let pendingRestores = 0;

export function registerPersistedPane(): void {
  pendingRestores += 1;
}

export function settlePersistedPane(): void {
  if (pendingRestores <= 0) return;
  pendingRestores -= 1;
  if (pendingRestores === 0) markBoot("restore-complete");
}

export function __resetBootTimingForTests(): void {
  reported.clear();
  pendingRestores = 0;
}
