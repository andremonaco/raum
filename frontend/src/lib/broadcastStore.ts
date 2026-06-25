/**
 * FLEET — "Synchronize input" (broadcast) store.
 *
 * When broadcast is active, a keystroke typed into the focused pane is
 * mirrored to every other member of the synced set. The actual fan-out lives
 * in `terminal-pane.tsx` (TERMINAL lane), which reads the three predicate
 * exports below verbatim — keep their names/signatures stable:
 *
 *   - isBroadcastActive(): boolean
 *   - isBroadcastMember(sessionId): boolean
 *   - broadcastMemberIds(): string[]
 *
 * Membership is resolved from a *scope* rather than a frozen id list, so a
 * session that spawns into the active project (or anywhere, for "all-visible")
 * automatically joins without the user re-arming the toggle:
 *
 *   - "manual"         — exactly the ids the user toggled in (the explicit set)
 *   - "active-project" — every harness in the active project's grid
 *   - "all-visible"    — every live harness across projects
 *
 * Reactive: the predicates read Solid signals, so consumers re-run when the
 * toggle flips, the scope changes, or (for the project/visible scopes) the
 * underlying terminal index churns.
 */

import { createSignal, type Accessor } from "solid-js";
import { harnessIds, idsByProjectSlug } from "../stores/terminalStore";
import { activeProjectSlug } from "../stores/projectStore";

export type BroadcastScope = "manual" | "active-project" | "all-visible";

const [active, setActive] = createSignal(false);
const [scope, setScope] = createSignal<BroadcastScope>("active-project");
// The explicit member set used by the "manual" scope. A plain reactive set
// (stored as a frozen array signal) so adding/removing a single id is cheap
// and referential identity changes only when membership does.
const [manualIds, setManualIds] = createSignal<ReadonlySet<string>>(new Set());

// ---- public predicates (consumed by TERMINAL — do not rename) -------------

/** Whether input mirroring is currently armed. */
export function isBroadcastActive(): boolean {
  return active();
}

/**
 * Resolve the current synced set to a concrete id array. Empty when broadcast
 * is off. For the scoped modes this reads the terminal indices live, so the
 * set tracks spawns/closes without re-arming.
 */
export function broadcastMemberIds(): string[] {
  if (!active()) return [];
  const s = scope();
  if (s === "manual") {
    // Only ids that are still live harnesses — a closed session shouldn't
    // linger in the set and resurrect a dead id on the next fan-out.
    const hs = harnessIds();
    return Array.from(manualIds()).filter((id) => hs.has(id));
  }
  if (s === "all-visible") {
    return Array.from(harnessIds());
  }
  // "active-project"
  const slug = activeProjectSlug();
  if (!slug) return [];
  const ids = idsByProjectSlug().get(slug);
  return ids ? Array.from(ids) : [];
}

/** Whether `sessionId` participates in the current synced set. */
export function isBroadcastMember(sessionId: string): boolean {
  if (!active()) return false;
  const s = scope();
  if (s === "manual") {
    return manualIds().has(sessionId) && harnessIds().has(sessionId);
  }
  if (s === "all-visible") {
    return harnessIds().has(sessionId);
  }
  const slug = activeProjectSlug();
  if (!slug) return false;
  return idsByProjectSlug().get(slug)?.has(sessionId) ?? false;
}

// ---- FLEET-only setters (top-row UI) --------------------------------------

/** Reactive accessor for the armed state — for the top-row toggle's pressed UI. */
export const broadcastActive: Accessor<boolean> = active;
/** Reactive accessor for the current scope — for the scope picker. */
export const broadcastScope: Accessor<BroadcastScope> = scope;

export function setBroadcastActive(next: boolean): void {
  setActive(next);
}

export function toggleBroadcast(): void {
  setActive((v) => !v);
}

export function setBroadcastScope(next: BroadcastScope): void {
  setScope(next);
}

/** Add a single session to the explicit ("manual") member set. */
export function addBroadcastMember(sessionId: string): void {
  if (!sessionId) return;
  setManualIds((prev) => {
    if (prev.has(sessionId)) return prev;
    const next = new Set(prev);
    next.add(sessionId);
    return next;
  });
}

/** Remove a single session from the explicit ("manual") member set. */
export function removeBroadcastMember(sessionId: string): void {
  setManualIds((prev) => {
    if (!prev.has(sessionId)) return prev;
    const next = new Set(prev);
    next.delete(sessionId);
    return next;
  });
}

/** Toggle a session in/out of the explicit member set. */
export function toggleBroadcastMember(sessionId: string): void {
  if (!sessionId) return;
  setManualIds((prev) => {
    const next = new Set(prev);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    return next;
  });
}

/** Replace the explicit member set wholesale (e.g. from a multi-select). */
export function setBroadcastMembers(ids: Iterable<string>): void {
  setManualIds(new Set(ids));
}

/** Reactive accessor over the explicit member set — for the scope picker UI. */
export const broadcastManualIds: Accessor<ReadonlySet<string>> = manualIds;

/** Test-only reset. */
export function __resetBroadcastStoreForTests(): void {
  setActive(false);
  setScope("active-project");
  setManualIds(new Set<string>());
}
