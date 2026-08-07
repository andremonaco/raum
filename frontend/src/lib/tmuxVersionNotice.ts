/**
 * "Your tmux has a known display bug" notice.
 *
 * tmux 3.4 ≤ v < 3.7b garbles fullscreen TUIs (tmux/tmux#5340) — Claude Code
 * ≥ 2.1.200 triggers it on every initial paint. Package managers only ensure
 * tmux is *present*, never that it is current, and the running `-L raum`
 * server keeps executing the old version until reborn, so raum checks at boot
 * (backend: `commands::tmux_health`) and prompts.
 *
 * Two variants, decided by whether the installed binary is already fixed:
 * upgraded binary → offer the deferred server restart (same mechanism as the
 * TCC migration notice); still-buggy binary → instruct the package upgrade
 * first, since restarting would just rebirth the same buggy version.
 *
 * Same toast shape as `serverRestartNotice.ts`: stable id, infinite duration,
 * at most once per launch. Dismissal is keyed by server version backend-side.
 */

import { invoke } from "@tauri-apps/api/core";
import { toast } from "solid-sonner";

/** Stable toast id, so a re-check refreshes rather than stacks. */
const TMUX_VERSION_TOAST_ID = "raum-tmux-version";

interface TmuxVersionStatus {
  needed: boolean;
  server_version: string;
  binary_fixed: boolean;
  live_sessions: number;
}

/** Guards against a second toast within one launch. */
let shown = false;

/**
 * Check once on boot and, if the running tmux server is in a known-buggy
 * version range, show the notice. Silent everywhere else.
 */
export async function maybeShowTmuxVersionNotice(): Promise<void> {
  if (shown) return;
  let status: TmuxVersionStatus;
  try {
    status = await invoke<TmuxVersionStatus>("tmux_version_status");
  } catch (e) {
    console.warn("tmux_version_status failed", e);
    return;
  }
  if (!status.needed) return;
  shown = true;

  const n = status.live_sessions;
  const sessions = n === 1 ? "1 running session" : `${n} running sessions`;
  const dismiss = {
    label: "Don't show again",
    onClick: () => {
      void invoke("tmux_version_dismiss", { version: status.server_version }).catch((e) =>
        console.warn("tmux_version_dismiss failed", e),
      );
    },
  };

  if (status.binary_fixed) {
    // Binary already upgraded; only the long-lived server is stale.
    toast("Restart the terminal server", {
      id: TMUX_VERSION_TOAST_ID,
      description:
        `The terminal server is running tmux ${status.server_version}, which has a ` +
        `display bug that garbles fullscreen agent UIs. The installed tmux is already ` +
        `fixed — restarting picks it up. Agent sessions are restored automatically; ` +
        `anything running in a plain terminal pane will stop (${sessions}).`,
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
      cancel: dismiss,
    });
    return;
  }

  // Binary itself is buggy: restarting now would rebirth the same version.
  toast("Update tmux", {
    id: TMUX_VERSION_TOAST_ID,
    description:
      `tmux ${status.server_version} has a display bug that garbles fullscreen agent ` +
      `UIs (fixed in 3.7b). Update it — \`brew upgrade tmux\` on macOS, or your ` +
      `distribution's package manager — and raum will offer a server restart on the ` +
      `next launch.`,
    duration: Number.POSITIVE_INFINITY,
    cancel: dismiss,
  });
}
