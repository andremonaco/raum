/**
 * One-time "restart the terminal server" notice.
 *
 * Installs before 0.1.13 birthed the tmux server in a way that makes macOS
 * attribute pane permissions to `tmux` instead of raum, and updating raum can't
 * undo it — the server outlives the app, so it has to be replaced once. That
 * costs the user their live sessions, so raum asks rather than acts.
 *
 * Surfaced as a persistent in-app toast, the same shape as the update notice in
 * `updateNotifier.ts`: a stable id and an infinite duration, so it's simply
 * *there* whenever the user next looks at the window rather than expiring while
 * they're away.
 *
 * Shown at most once per launch, and the check is self-clearing — after the
 * restart the backend no longer detects a legacy server, so nothing needs to be
 * remembered for the common case. The dismissal flag exists only for someone
 * who declines outright.
 */

import { invoke } from "@tauri-apps/api/core";
import { toast } from "solid-sonner";

/** Stable toast id, so a re-check refreshes rather than stacks. */
const RESTART_TOAST_ID = "raum-server-restart";

interface ServerRestartStatus {
  needed: boolean;
  live_sessions: number;
}

/** Guards against a second toast within one launch (e.g. a re-focus check). */
let shown = false;

/**
 * Check once on boot and, if this install is still on a legacy server, show the
 * notice. Silent on every other install — and on Linux, where the backend
 * always answers `needed: false`.
 */
export async function maybeShowServerRestartNotice(): Promise<void> {
  if (shown) return;
  let status: ServerRestartStatus;
  try {
    status = await invoke<ServerRestartStatus>("server_restart_status");
  } catch (e) {
    console.warn("server_restart_status failed", e);
    return;
  }
  if (!status.needed) return;
  shown = true;

  // Be specific about the cost. "Your sessions will stop" invites a shrug;
  // "12 running sessions" is a number the user can weigh against their day.
  const n = status.live_sessions;
  const sessions = n === 1 ? "1 running session" : `${n} running sessions`;

  toast("Restart the terminal server", {
    id: RESTART_TOAST_ID,
    description:
      `Restarting applies a macOS permissions fix from this update. ` +
      `Agent sessions are restored automatically; anything running in a plain ` +
      `terminal pane will stop (${sessions}).`,
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: "Restart",
      onClick: () => {
        // Never resolves on success — the backend flushes and execs.
        void invoke("server_restart_now").catch((e) => {
          console.warn("server_restart_now failed", e);
          toast.error("Couldn't restart", {
            description: e instanceof Error ? e.message : String(e),
          });
        });
      },
    },
    cancel: {
      label: "Don't show again",
      onClick: () => {
        void invoke("server_restart_dismiss").catch((e) =>
          console.warn("server_restart_dismiss failed", e),
        );
      },
    },
  });
}
