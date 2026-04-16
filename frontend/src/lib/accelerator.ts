/**
 * §4.8 — minimal accelerator matcher for in-webview keydown events.
 *
 * This only understands the subset of accelerators used by Wave 3A
 * (modifier + printable key). It intentionally does not attempt to be a full
 * Tauri-global-shortcut compatible implementation — §12.4 will replace it
 * with a proper keymap provider.
 */

export function matchesAccelerator(event: KeyboardEvent, accel: string): boolean {
  if (!accel) return false;
  const parts = accel.split("+").map((p) => p.trim());
  if (parts.length === 0) return false;

  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

  let needCmdOrCtrl = false;
  let needCmd = false;
  let needCtrl = false;
  let needShift = false;
  let needAlt = false;
  let keyPart: string | null = null;

  for (const part of parts) {
    const norm = part.toLowerCase();
    if (norm === "cmdorctrl" || norm === "commandorcontrol") {
      needCmdOrCtrl = true;
    } else if (norm === "cmd" || norm === "command" || norm === "meta" || norm === "super") {
      needCmd = true;
    } else if (norm === "ctrl" || norm === "control") {
      needCtrl = true;
    } else if (norm === "shift") {
      needShift = true;
    } else if (norm === "alt" || norm === "option") {
      needAlt = true;
    } else {
      keyPart = part;
    }
  }
  if (!keyPart) return false;

  if (needCmdOrCtrl) {
    const ok = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!ok) return false;
  } else {
    if (needCmd && !event.metaKey) return false;
    if (!needCmd && event.metaKey && !needCmdOrCtrl) {
      // Extra meta pressed without being required — reject.
      return false;
    }
    if (needCtrl && !event.ctrlKey) return false;
    if (!needCtrl && event.ctrlKey && !needCmdOrCtrl) return false;
  }
  if (needShift !== event.shiftKey) return false;
  if (needAlt !== event.altKey) return false;

  // Compare key. Accelerator uses "F"/"G"/"/" etc; event.key is usually
  // lowercase unless shift flips it.
  const wantKey = keyPart.length === 1 ? keyPart.toLowerCase() : keyPart.toLowerCase();
  const gotKey = (event.key || "").toLowerCase();
  return wantKey === gotKey;
}
