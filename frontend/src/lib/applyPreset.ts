/**
 * §10.4 — apply-preset flow.
 *
 * Given a `LayoutPreset` and the target `worktreeId`, spawn a fresh tmux
 * session for every declared pane (cells with `kind === "empty"` are skipped).
 * Sessions are created via `terminal_spawn` — the live bytes are plumbed
 * by `<TerminalPane>` once the pane mounts, so `applyPreset` only needs to
 * seed session ids.
 *
 * Before applying, the caller must resolve the "running agents" decision
 * (`keep` / `replace` / `merge`) via the `onConflict` callback. Callers that
 * skip the modal (e.g. programmatic presets from tests) can pass a pre-chosen
 * resolution.
 *
 * On success the worktree's last-used preset pointer is updated through
 * `worktree_preset_set`. The update is debounced via `layoutPresetStore.schedule`
 * (§10.9) so a burst of "apply preset" clicks collapses into one backend call.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

import type { AgentKind } from "./agentKind";
import type { LayoutPreset } from "../stores/layoutPresetStore";
import { schedule as scheduleDebounced } from "../stores/layoutPresetStore";
import {
  nextCellId,
  nextTabId,
  setRuntimeLayout,
  type RuntimeCell,
} from "../stores/runtimeLayoutStore";

export type ApplyConflictResolution = "keep" | "replace" | "merge" | "cancel";

export interface ApplyPresetOptions {
  /** Tauri worktree id to target. Typically the worktree `path`. */
  worktreeId: string;
  /** Project slug for the new tmux sessions. */
  projectSlug?: string;
  /** Working directory for new sessions; usually the worktree root. */
  cwd?: string;
  /**
   * Called when at least one pane in the target worktree already has a live
   * agent. Resolves to the user's choice. If omitted, defaults to `"replace"`.
   */
  onConflict?: () => Promise<ApplyConflictResolution>;
  /**
   * Optional running-agents snapshot. The caller (the grid UI) typically
   * queries `terminal_list` + filters by `worktreeId`; tests can inject a
   * deterministic list.
   */
  runningAgents?: Array<{ sessionId: string; kind: AgentKind }>;
}

export interface ApplyPresetResult {
  resolution: ApplyConflictResolution;
  spawned: number;
  skipped: number;
}

/**
 * Apply a preset to the given worktree. Spawns `terminal_spawn` for each
 * non-empty cell, pushes the runtime layout store, and (on success) updates
 * the worktree preset pointer.
 */
export async function applyPreset(
  preset: LayoutPreset,
  options: ApplyPresetOptions,
): Promise<ApplyPresetResult> {
  // Resolve conflict first.
  const running = options.runningAgents ?? [];
  let resolution: ApplyConflictResolution = "replace";
  if (running.length > 0) {
    resolution = options.onConflict ? await options.onConflict() : "replace";
    if (resolution === "cancel") {
      return { resolution, spawned: 0, skipped: preset.cells.length };
    }
  }

  // If `replace`, kill existing sessions. `merge` leaves them alone; `keep`
  // also leaves them but skips spawning anything new (user just wanted to
  // update the pointer + layout visual).
  if (resolution === "replace") {
    for (const r of running) {
      try {
        await invoke("terminal_kill", { sessionId: r.sessionId });
      } catch (err) {
        console.warn("[applyPreset] terminal_kill failed", err);
      }
    }
  }

  // Build runtime cells with fresh ids. We spawn tmux sessions for every
  // non-empty cell *unless* resolution === "keep", in which case we only
  // sync the layout visual and reuse existing sessions one-to-one in order.
  const runtimeCells: RuntimeCell[] = [];
  let spawned = 0;
  let skipped = 0;
  const reuseQueue = resolution === "keep" ? [...running] : [];
  for (const cell of preset.cells) {
    const tabId = nextTabId();
    const runtimeCell: RuntimeCell = {
      id: nextCellId(),
      x: cell.x,
      y: cell.y,
      w: cell.w,
      h: cell.h,
      kind: cell.kind,
      tabs: [{ id: tabId }],
      activeTabId: tabId,
      ...(cell.title ? { title: cell.title } : {}),
    };
    runtimeCells.push(runtimeCell);

    if (cell.kind === "empty") {
      skipped += 1;
      continue;
    }

    if (resolution === "keep" && reuseQueue.length > 0) {
      const reuse = reuseQueue.shift()!;
      runtimeCell.tabs[0].sessionId = reuse.sessionId;
      continue;
    }

    // Spawn a new session. We intentionally do not await bytes — the live
    // stream is owned by `<TerminalPane>`. The `Channel` here is a throwaway
    // sink because `terminal_spawn` requires it. TerminalPane re-spawns with
    // its own channel once the pane mounts with the given session id; but
    // terminal_spawn creates a *new* session each time. To keep the contract
    // honest, we call terminal_spawn here, discard the bytes, and pass the
    // returned session id to TerminalPane via `sessionId` prop. TerminalPane
    // detects the prop and attaches to that session id without re-spawning.
    const sink = new Channel<Uint8Array>();
    sink.onmessage = () => {
      /* drop; TerminalPane will re-subscribe on mount. */
    };
    try {
      const sessionId = await invoke<string>("terminal_spawn", {
        args: {
          projectSlug: options.projectSlug,
          worktreeId: options.worktreeId,
          kind: cell.kind as AgentKind,
          cwd: options.cwd,
        },
        onData: sink,
      });
      runtimeCell.tabs[0].sessionId = sessionId;
      spawned += 1;
    } catch (err) {
      console.error("[applyPreset] terminal_spawn failed", err);
      skipped += 1;
    }
  }

  // Push into the runtime store so the grid re-renders. Cells already carry
  // their tab sessionIds from the spawn loop above.
  setRuntimeLayout(runtimeCells, preset.name);

  // §10.4 — update the worktree preset pointer, debounced at 500 ms.
  scheduleDebounced(`preset-pointer:${options.worktreeId}`, async () => {
    try {
      await invoke("worktree_preset_set", {
        worktreeId: options.worktreeId,
        presetName: preset.name,
      });
    } catch (err) {
      console.error("[applyPreset] worktree_preset_set failed", err);
    }
  });

  return { resolution, spawned, skipped };
}
