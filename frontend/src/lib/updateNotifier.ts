/**
 * In-app update notifications.
 *
 * raum deliberately surfaces "a new version is available" *inside the app*
 * rather than as an OS banner: OS banners are easy to overlook, and a focused
 * window suppresses them anyway. The toast here uses a stable id and an
 * infinite duration, so it survives an unfocused/backgrounded window and is
 * simply *present* the moment the user looks back at raum — covering both the
 * "focused now" and "refocused later" cases with one surface, no focus
 * listener required.
 *
 * Two entry points share this module:
 *   - the periodic background poll in `app.tsx` (`interactive: false`)
 *   - the macOS "Check for Updates…" menu item, routed through `top-row.tsx`
 *     (`interactive: true`)
 *
 * The actual download / progress / relaunch UI lives in the Settings → Updates
 * pane; the toast's "Install…" action just routes there via the
 * `raum:open-settings` window event (handled in `top-row.tsx`).
 */

import { getVersion } from "@tauri-apps/api/app";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { toast } from "solid-sonner";

/** Stable toast id so repeated checks refresh one toast instead of stacking. */
const UPDATE_TOAST_ID = "raum-update";

/** Detail payload for the `raum:open-settings` window event. */
export interface OpenSettingsDetail {
  section: "updates";
}

/**
 * Last version we surfaced a toast for. Dedupes the background poll so a
 * release the user has already dismissed isn't re-popped every 5 hours. An
 * interactive check passes `force` to bypass this, so clicking "Check for
 * Updates…" always shows the toast even for an already-seen version.
 */
let lastShownVersion: string | null = null;

/** Show (or refresh) the persistent in-app "update available" toast. */
export function showUpdateAvailable(version: string, opts?: { force?: boolean }): void {
  if (!opts?.force && lastShownVersion === version) return;
  lastShownVersion = version;
  toast(`raum ${version} is available`, {
    id: UPDATE_TOAST_ID,
    description: "A new version is ready to install.",
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: "Install…",
      onClick: () => {
        window.dispatchEvent(
          new CustomEvent<OpenSettingsDetail>("raum:open-settings", {
            detail: { section: "updates" },
          }),
        );
      },
    },
  });
}

/**
 * Run a single updater check.
 *
 * On a new version → the persistent toast. When `interactive` (the user clicked
 * "Check for Updates…"), also report the up-to-date / error outcome so the click
 * has visible feedback; background checks stay silent on those paths and swallow
 * network errors so a missing connection never bubbles out of the timer.
 */
export async function runUpdateCheck(opts: { interactive: boolean }): Promise<void> {
  try {
    const update = await checkForUpdate();
    if (update) {
      showUpdateAvailable(update.version, { force: opts.interactive });
    } else if (opts.interactive) {
      const current = await getVersion();
      toast.success("raum is up to date", { description: `You're on ${current}.` });
    }
  } catch (e) {
    if (opts.interactive) {
      toast.error("Couldn't check for updates", {
        description: e instanceof Error ? e.message : String(e),
      });
    } else {
      console.warn("background update check failed", e);
    }
  }
}
