import type { JSXElement } from "solid-js";
import { Component } from "solid-js";

import { cx } from "~/lib/cva";
import {
  notificationDevMode,
  openNotificationSystemSettings,
  permissionState,
  refreshNotificationAuthorization,
} from "../../lib/notificationCenter";

import { linuxNotificationServiceUnavailable } from "./utils";

// ---------------------------------------------------------------------------
// Permission status badge
// ---------------------------------------------------------------------------

export const PermissionBadge: Component = () => {
  const label = () => {
    if (notificationDevMode()) return "Dev build";
    if (linuxNotificationServiceUnavailable()) return "Unavailable";
    const s = permissionState();
    return s === "granted" ? "Granted" : s === "denied" ? "Denied" : "Not set";
  };
  const color = () => {
    if (notificationDevMode()) {
      return "bg-muted text-muted-foreground hover:bg-muted/70";
    }
    if (linuxNotificationServiceUnavailable()) {
      return "bg-warning/15 text-warning hover:bg-warning/25";
    }
    const s = permissionState();
    return s === "granted"
      ? "bg-success/15 text-success hover:bg-success/25"
      : s === "denied"
        ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
        : "bg-muted text-muted-foreground hover:bg-muted/70";
  };

  const onClick = async () => {
    await openNotificationSystemSettings();
    // Best-effort re-probe a moment after the user returns. The OS pane
    // opens asynchronously and the user may toggle in either direction;
    // a delayed refresh covers both cases without polling.
    window.setTimeout(() => void refreshNotificationAuthorization(), 1500);
  };

  return (
    <button
      type="button"
      class={cx(
        "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        color(),
      )}
      onClick={onClick}
      title="Open System Settings → Notifications"
    >
      {label()}
    </button>
  );
};

// ---------------------------------------------------------------------------
// Toggle row
// ---------------------------------------------------------------------------

export const ToggleRow: Component<{
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}> = (props) => {
  return (
    <label class="flex cursor-pointer items-center justify-between gap-3 rounded border border-border bg-card/30 px-3 py-2">
      <div class="min-w-0 flex-1">
        <p class="text-xs text-foreground">{props.label}</p>
        <p class="text-[10px] text-muted-foreground">{props.description}</p>
      </div>
      {/* Custom toggle switch */}
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        disabled={props.disabled}
        class={cx(
          "relative h-4 w-7 shrink-0 rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
          props.checked ? "bg-primary" : "bg-input",
        )}
        onClick={(e) => {
          e.stopPropagation();
          props.onChange(!props.checked);
        }}
      >
        <span
          class={cx(
            "block size-3 rounded-full bg-background shadow-sm transition-transform",
            props.checked ? "translate-x-3" : "translate-x-0",
          )}
        />
      </button>
    </label>
  );
};

// ---------------------------------------------------------------------------
// Status pill (used in notifications summary + harness rows)
// ---------------------------------------------------------------------------

export const StatusPill: Component<{
  tone: "ok" | "warn" | "error" | "muted";
  children: JSXElement;
}> = (props) => {
  const color = () => {
    switch (props.tone) {
      case "ok":
        return "bg-success/15 text-success";
      case "warn":
        return "bg-warning/15 text-warning";
      case "error":
        return "bg-destructive/15 text-destructive";
      case "muted":
        return "bg-muted text-muted-foreground";
    }
  };
  return (
    <span
      class={cx(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
        color(),
      )}
    >
      {props.children}
    </span>
  );
};
