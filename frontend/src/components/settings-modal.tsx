/**
 * General settings modal for raum.
 *
 * Two-pane layout (inspired by Canopy):
 *   - Left  — narrow nav sidebar listing settings sections
 *   - Right — content panel for the active section
 *
 * Sections:
 *   - Notifications — OS permission + when-to-notify toggles + sound
 *   - Harnesses     — per-harness extra CLI flags appended at spawn time
 */

import type { JSXElement } from "solid-js";
import { Component, For, Show, createEffect, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Dialog as DialogPrimitive } from "@kobalte/core/dialog";

import { cx } from "~/lib/cva";
import {
  ensureNotificationPermission,
  permissionState,
  refreshNotificationConfig,
} from "../lib/notificationCenter";
import { HARNESS_ICONS, type HarnessIconKind } from "./icons";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SectionId = "notifications" | "harnesses";

interface Section {
  id: SectionId;
  label: string;
  icon: () => JSXElement;
}

// ---------------------------------------------------------------------------
// Nav sections
// ---------------------------------------------------------------------------

const SECTIONS: Section[] = [
  {
    id: "notifications",
    label: "Notifications",
    icon: () => (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="size-3 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
    ),
  },
  {
    id: "harnesses",
    label: "Harnesses",
    icon: () => (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="size-3 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="9" y="9" width="6" height="6" rx="1" />
        <path d="M9 3h6M9 21h6M3 9v6M21 9v6" />
        <path d="M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2" />
      </svg>
    ),
  },
];

// ---------------------------------------------------------------------------
// Permission status badge
// ---------------------------------------------------------------------------

const PermissionBadge: Component = () => {
  const label = () => {
    const s = permissionState();
    return s === "granted" ? "Granted" : s === "denied" ? "Denied" : "Not set";
  };
  const color = () => {
    const s = permissionState();
    return s === "granted"
      ? "bg-emerald-500/15 text-emerald-400"
      : s === "denied"
        ? "bg-red-500/15 text-red-400"
        : "bg-zinc-500/15 text-zinc-400";
  };

  return (
    <span class={cx("rounded px-1.5 py-0.5 text-[10px] font-medium", color())}>{label()}</span>
  );
};

// ---------------------------------------------------------------------------
// Toggle row
// ---------------------------------------------------------------------------

const ToggleRow: Component<{
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
// Notifications section
// ---------------------------------------------------------------------------

interface NotifConfig {
  notify_on_waiting: boolean;
  notify_on_done: boolean;
  sound: string | null;
}

const NotificationsSection: Component = () => {
  const [config] = createResource<NotifConfig>(async () => {
    const cfg = await invoke<{
      notifications?: {
        notify_on_waiting?: boolean;
        notify_on_done?: boolean;
        sound?: string | null;
      };
    }>("config_get");
    return {
      notify_on_waiting: cfg.notifications?.notify_on_waiting ?? true,
      notify_on_done: cfg.notifications?.notify_on_done ?? true,
      sound: cfg.notifications?.sound ?? null,
    };
  });

  // Local editable copies of the config values
  const [localWaiting, setLocalWaiting] = createSignal(true);
  const [localDone, setLocalDone] = createSignal(true);
  const [localSound, setLocalSound] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  // Seed local state once config loads
  const [seeded, setSeeded] = createSignal(false);

  createEffect(() => {
    const c = config();
    if (c && !seeded()) {
      setLocalWaiting(c.notify_on_waiting);
      setLocalDone(c.notify_on_done);
      setLocalSound(c.sound ?? "");
      setSeeded(true);
    }
  });

  const saveConfig = async (patch: { waiting?: boolean; done?: boolean; sound?: string }) => {
    setSaving(true);
    try {
      await invoke("config_set_notifications", {
        notifyOnWaiting: patch.waiting ?? localWaiting(),
        notifyOnDone: patch.done ?? localDone(),
        sound: (patch.sound ?? localSound()) || null,
      });
      await refreshNotificationConfig();
    } catch (e) {
      console.warn("config_set_notifications failed", e);
    } finally {
      setSaving(false);
    }
  };

  const handleWaitingToggle = async (v: boolean) => {
    setLocalWaiting(v);
    await saveConfig({ waiting: v });
  };

  const handleDoneToggle = async (v: boolean) => {
    setLocalDone(v);
    await saveConfig({ done: v });
  };

  const handleSoundBlur = async () => {
    await saveConfig({ sound: localSound() });
  };

  const handleRequestPermission = async () => {
    await ensureNotificationPermission();
  };

  return (
    <div class="flex flex-col gap-4">
      {/* OS Permission */}
      <div class="flex flex-col gap-1.5">
        <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">OS Permission</h4>
        <div class="flex items-center justify-between rounded border border-border bg-card/30 px-3 py-2">
          <div>
            <p class="text-xs text-foreground">System notifications</p>
            <p class="text-[10px] text-muted-foreground">
              Required to show alerts in the notification center.
            </p>
          </div>
          <div class="flex items-center gap-2">
            <PermissionBadge />
            <Show when={permissionState() !== "granted"}>
              <button
                type="button"
                class="rounded border border-border bg-background px-2 py-0.5 text-[10px] text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                onClick={handleRequestPermission}
                disabled={saving()}
              >
                Request
              </button>
            </Show>
          </div>
        </div>
      </div>

      {/* When to notify */}
      <div class="flex flex-col gap-1.5">
        <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">When to notify</h4>
        <div class="flex flex-col gap-1">
          <ToggleRow
            label="Agent needs input"
            description="Notify when an agent is waiting for your reply."
            checked={seeded() ? localWaiting() : (config()?.notify_on_waiting ?? true)}
            onChange={handleWaitingToggle}
            disabled={saving()}
          />
          <ToggleRow
            label="Agent finished"
            description="Notify when an agent completes or encounters an error."
            checked={seeded() ? localDone() : (config()?.notify_on_done ?? true)}
            onChange={handleDoneToggle}
            disabled={saving()}
          />
        </div>
      </div>

      {/* Sound */}
      <div class="flex flex-col gap-1.5">
        <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">Sound</h4>
        <div class="flex flex-col gap-1.5 rounded border border-border bg-card/30 px-3 py-2">
          <p class="text-[10px] text-muted-foreground">
            Absolute path to a sound file played with each notification. Leave blank to use no
            sound.
          </p>
          <input
            type="text"
            placeholder="/path/to/sound.mp3"
            class="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none disabled:opacity-50"
            value={seeded() ? localSound() : (config()?.sound ?? "")}
            onInput={(e) => setLocalSound(e.currentTarget.value)}
            onBlur={handleSoundBlur}
            disabled={saving()}
          />
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Harnesses section
// ---------------------------------------------------------------------------

interface HarnessEntry {
  id: HarnessIconKind;
  label: string;
  binary: string;
  description: string;
  placeholder: string;
}

const HARNESS_ENTRIES: HarnessEntry[] = [
  {
    id: "shell",
    label: "Shell",
    binary: "sh",
    description: "Standard POSIX shell",
    placeholder: "--login -x",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    binary: "claude",
    description: "Anthropic AI coding assistant",
    placeholder: "--verbose --model claude-opus-4-5",
  },
  {
    id: "codex",
    label: "Codex",
    binary: "codex",
    description: "OpenAI terminal agent",
    placeholder: "--approval-mode full-auto",
  },
  {
    id: "opencode",
    label: "OpenCode",
    binary: "opencode",
    description: "Open-source AI terminal",
    placeholder: "--model anthropic/claude-opus-4-5",
  },
];

const HarnessesSection: Component = () => {
  const [config] = createResource(async () => {
    const cfg = await invoke<{
      harnesses?: {
        shell?: { extra_flags?: string | null };
        "claude-code"?: { extra_flags?: string | null };
        codex?: { extra_flags?: string | null };
        opencode?: { extra_flags?: string | null };
      };
    }>("config_get");
    return cfg.harnesses ?? {};
  });

  const [localFlags, setLocalFlags] = createSignal<Record<string, string>>({});
  const [seeded, setSeeded] = createSignal(false);

  createEffect(() => {
    const h = config();
    if (h && !seeded()) {
      setLocalFlags({
        shell: h.shell?.extra_flags ?? "",
        "claude-code": h["claude-code"]?.extra_flags ?? "",
        codex: h.codex?.extra_flags ?? "",
        opencode: h.opencode?.extra_flags ?? "",
      });
      setSeeded(true);
    }
  });

  const handleInput = (id: HarnessIconKind, value: string) => {
    setLocalFlags((prev) => ({ ...prev, [id]: value }));
  };

  const handleBlur = async (id: HarnessIconKind) => {
    const flags = localFlags()[id] ?? "";
    try {
      await invoke("config_set_harness_flags", {
        harness: id,
        flags: flags.trim() || null,
      });
    } catch (e) {
      console.warn("config_set_harness_flags failed", e);
    }
  };

  return (
    <div class="flex flex-col gap-3">
      <p class="text-[10px] text-muted-foreground">
        Extra flags are appended verbatim to the harness binary when a new pane is spawned.
      </p>
      <div class="flex flex-col gap-2">
        <For each={HARNESS_ENTRIES}>
          {(entry) => {
            const Icon = HARNESS_ICONS[entry.id];
            return (
              <div class="overflow-hidden rounded border border-border bg-card/30">
                {/* Header row */}
                <div class="flex items-center gap-2.5 border-b border-border/50 px-3 py-2.5">
                  <div class="flex size-6 shrink-0 items-center justify-center rounded border border-border/60 bg-background">
                    <Icon class="size-3.5 text-foreground" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="text-xs font-medium text-foreground">{entry.label}</p>
                    <p class="text-[10px] text-muted-foreground">
                      {entry.binary} · {entry.description}
                    </p>
                  </div>
                </div>
                {/* Flags input */}
                <div class="px-3 py-2">
                  <p class="mb-1 text-[9px] uppercase tracking-wider text-muted-foreground/60">
                    Extra flags
                  </p>
                  <input
                    type="text"
                    placeholder={entry.placeholder}
                    class="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-ring focus:outline-none"
                    value={seeded() ? (localFlags()[entry.id] ?? "") : ""}
                    onInput={(e) => handleInput(entry.id, e.currentTarget.value)}
                    onBlur={() => handleBlur(entry.id)}
                  />
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Section router
// ---------------------------------------------------------------------------

const SectionContent: Component<{ section: SectionId }> = (props) => {
  return (
    <>
      <Show when={props.section === "notifications"}>
        <NotificationsSection />
      </Show>
      <Show when={props.section === "harnesses"}>
        <HarnessesSection />
      </Show>
    </>
  );
};

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export const SettingsModal: Component<SettingsModalProps> = (props) => {
  const [activeSection, setActiveSection] = createSignal<SectionId>("notifications");

  return (
    <DialogPrimitive open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogPrimitive.Portal>
        {/* Overlay */}
        <DialogPrimitive.Overlay class="data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 fixed inset-0 z-50 bg-black/60" />

        {/* Modal shell */}
        <DialogPrimitive.Content
          class="data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95 fixed top-[50%] left-[50%] z-50 flex w-full max-w-2xl translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl duration-200 focus:outline-none"
          style={{ height: "520px" }}
        >
          {/* Title row (visually hidden, for accessibility) */}
          <DialogPrimitive.Title class="sr-only">Settings</DialogPrimitive.Title>

          {/* Body: left sidebar + right content */}
          <div class="flex min-h-0 flex-1 overflow-hidden">
            {/* Left nav sidebar */}
            <div class="flex w-40 shrink-0 flex-col border-r border-border bg-zinc-900/50">
              {/* Sidebar header */}
              <div class="flex h-9 items-center px-3">
                <span class="text-xs text-foreground">Settings</span>
              </div>

              {/* Nav items */}
              <nav class="flex-1 overflow-y-auto px-1.5 pb-1.5">
                <p class="mb-0.5 px-1.5 pt-2 text-[9px] uppercase tracking-wider text-muted-foreground/50">
                  General
                </p>
                <For each={SECTIONS}>
                  {(section) => (
                    <button
                      type="button"
                      class={cx(
                        "flex w-full items-center gap-2 rounded px-1.5 py-1 text-[11px] transition-colors",
                        activeSection() === section.id
                          ? "bg-accent text-accent-foreground font-medium"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                      onClick={() => setActiveSection(section.id)}
                    >
                      {section.icon()}
                      {section.label}
                    </button>
                  )}
                </For>
              </nav>
            </div>

            {/* Right content */}
            <div class="flex min-w-0 flex-1 flex-col">
              {/* Content header bar */}
              <div class="flex h-9 shrink-0 items-center justify-between border-b border-border px-4">
                <span class="text-xs text-foreground">
                  {SECTIONS.find((s) => s.id === activeSection())?.label}
                </span>
                <DialogPrimitive.CloseButton
                  class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Close settings"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    class="size-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </DialogPrimitive.CloseButton>
              </div>

              {/* Scrollable content area */}
              <div class="flex-1 overflow-y-auto px-4 py-4">
                <SectionContent section={activeSection()} />
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive>
  );
};
