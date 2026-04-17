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
import { getVersion } from "@tauri-apps/api/app";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { Dialog as DialogPrimitive } from "@kobalte/core/dialog";

import { cx } from "~/lib/cva";
import {
  ensureNotificationPermission,
  permissionState,
  previewSound,
  refreshNotificationConfig,
} from "../lib/notificationCenter";
import {
  harnessReport,
  refreshHarnessReport,
  type HarnessStatus,
} from "../stores/harnessStatusStore";
import { openUrl } from "@tauri-apps/plugin-opener";

import { CheckIcon, HARNESS_ICONS, PlayIcon, type HarnessIconKind } from "./icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

interface SystemSound {
  name: string;
  path: string;
}

// Sentinel for the "Custom path…" entry. Empty string means "no sound".
const CUSTOM_SOUND_VALUE = "__custom__";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SectionId = "notifications" | "harnesses" | "updates";

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
  {
    id: "updates",
    label: "Updates",
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
        <path d="M21 12a9 9 0 0 1-15.36 6.36L3 16" />
        <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8" />
        <polyline points="21 3 21 8 16 8" />
        <polyline points="3 21 3 16 8 16" />
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

  // OS-bundled sounds for the dropdown. Empty on platforms with no known
  // sound directory; the UI degrades to "None" + "Custom path…".
  const [systemSounds] = createResource<SystemSound[]>(async () => {
    try {
      return await invoke<SystemSound[]>("notifications_list_system_sounds");
    } catch (e) {
      console.warn("notifications_list_system_sounds failed", e);
      return [];
    }
  });

  // Local editable copies of the config values
  const [localWaiting, setLocalWaiting] = createSignal(true);
  const [localDone, setLocalDone] = createSignal(true);
  // The on-disk sound path stored in config. "" means no sound.
  const [localSound, setLocalSound] = createSignal("");
  // Whether the user has chosen "Custom path…" — sticks even if the path
  // happens to match a system sound, so they can edit freely.
  const [customMode, setCustomMode] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  // Seed local state once config loads
  const [seeded, setSeeded] = createSignal(false);

  createEffect(() => {
    const c = config();
    const sounds = systemSounds();
    if (c && sounds && !seeded()) {
      setLocalWaiting(c.notify_on_waiting);
      setLocalDone(c.notify_on_done);
      const path = c.sound ?? "";
      setLocalSound(path);
      // If a path is set and it doesn't match any discovered system sound,
      // open the dropdown in custom mode so the text input is visible.
      const matchesSystem = path !== "" && sounds.some((s) => s.path === path);
      setCustomMode(path !== "" && !matchesSystem);
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

  const handleSoundSelect = async (value: string) => {
    if (value === CUSTOM_SOUND_VALUE) {
      setCustomMode(true);
      // Don't touch the saved path — let the user fill the input first.
      return;
    }
    setCustomMode(false);
    setLocalSound(value);
    await saveConfig({ sound: value });
  };

  const handleCustomBlur = async () => {
    await saveConfig({ sound: localSound() });
  };

  const handlePreview = async () => {
    if (!localSound()) return;
    await previewSound(localSound());
  };

  const handleRequestPermission = async () => {
    await ensureNotificationPermission();
  };

  // Label shown in the dropdown trigger. Resolves the current value against
  // the system-sound list so users see "Glass" rather than the absolute path.
  const triggerLabel = () => {
    if (customMode()) return "Custom path…";
    const path = localSound();
    if (!path) return "None";
    const match = (systemSounds() ?? []).find((s) => s.path === path);
    return match?.name ?? "Custom path…";
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
            Pick an OS-bundled alert sound or point to your own file. Sounds are read from the
            user's system, never bundled or downloaded.
          </p>
          <div class="flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger
                as="button"
                type="button"
                disabled={saving()}
                class="flex flex-1 items-center justify-between gap-2 rounded border border-border bg-background px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent focus:border-ring focus:outline-none disabled:pointer-events-none disabled:opacity-50"
              >
                <span class="truncate">{triggerLabel()}</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="size-3 shrink-0 text-muted-foreground"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent class="max-h-[280px] min-w-[var(--kb-popper-anchor-width)] overflow-y-auto">
                  <DropdownMenuItem class="text-xs" onSelect={() => void handleSoundSelect("")}>
                    <CheckIcon
                      class={cx(
                        "size-3",
                        !customMode() && !localSound() ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span>None</span>
                  </DropdownMenuItem>
                  <Show when={(systemSounds() ?? []).length > 0}>
                    <DropdownMenuSeparator />
                    <For each={systemSounds() ?? []}>
                      {(s) => (
                        <DropdownMenuItem
                          class="text-xs"
                          onSelect={() => void handleSoundSelect(s.path)}
                        >
                          <CheckIcon
                            class={cx(
                              "size-3",
                              !customMode() && localSound() === s.path
                                ? "opacity-100"
                                : "opacity-0",
                            )}
                          />
                          <span>{s.name}</span>
                        </DropdownMenuItem>
                      )}
                    </For>
                  </Show>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    class="text-xs"
                    onSelect={() => void handleSoundSelect(CUSTOM_SOUND_VALUE)}
                  >
                    <CheckIcon class={cx("size-3", customMode() ? "opacity-100" : "opacity-0")} />
                    <span>Custom path…</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenu>
            <button
              type="button"
              class="flex size-7 shrink-0 items-center justify-center rounded border border-border bg-background text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              onClick={handlePreview}
              disabled={saving() || !localSound()}
              title="Play sound"
              aria-label="Play sound"
            >
              <PlayIcon class="size-3" />
            </button>
          </div>
          <Show when={customMode()}>
            <input
              type="text"
              placeholder="/path/to/sound.mp3"
              class="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none disabled:opacity-50"
              value={localSound()}
              onInput={(e) => setLocalSound(e.currentTarget.value)}
              onBlur={handleCustomBlur}
              disabled={saving()}
            />
          </Show>
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

// One-line install command per harness. Mirrors the onboarding wizard's
// suggestions so users see the same story in both places.
const INSTALL_COMMANDS: Partial<Record<HarnessIconKind, string>> = {
  "claude-code": "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  opencode: "npm install -g opencode-ai",
};

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

const StatusPill: Component<{
  tone: "ok" | "warn" | "error" | "muted";
  children: JSXElement;
}> = (props) => {
  const color = () => {
    switch (props.tone) {
      case "ok":
        return "bg-emerald-500/15 text-emerald-400";
      case "warn":
        return "bg-amber-500/15 text-amber-400";
      case "error":
        return "bg-red-500/15 text-red-400";
      case "muted":
        return "bg-zinc-500/15 text-zinc-400";
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

const HarnessStatusBadge: Component<{ status: HarnessStatus | undefined }> = (props) => {
  return (
    <Show when={props.status} fallback={<StatusPill tone="muted">Checking…</StatusPill>}>
      {(s) => (
        <Show when={s().found} fallback={<StatusPill tone="error">Not installed</StatusPill>}>
          <Show
            when={s().meetsMinimum === false}
            fallback={
              <span
                class="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400"
                title="Installed"
                aria-label="Installed"
              >
                <CheckIcon class="size-2.5" />
              </span>
            }
          >
            <StatusPill tone="warn">Out of date</StatusPill>
          </Show>
        </Show>
      )}
    </Show>
  );
};

const InstallPanel: Component<{
  kind: HarnessIconKind;
  docsUrl: string | null;
}> = (props) => {
  const command = () => INSTALL_COMMANDS[props.kind] ?? null;
  const [copied, setCopied] = createSignal(false);
  const [openingDocs, setOpeningDocs] = createSignal(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  const handleCopy = async () => {
    const cmd = command();
    if (!cmd) return;
    const ok = await copyToClipboard(cmd);
    if (ok) {
      setCopied(true);
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleOpenDocs = async () => {
    if (!props.docsUrl) return;
    setOpeningDocs(true);
    try {
      await openUrl(props.docsUrl);
    } catch (e) {
      console.warn("openUrl failed", e);
    } finally {
      setOpeningDocs(false);
    }
  };

  return (
    <div class="mt-1 flex flex-col gap-1.5 rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
      <p class="text-[10px] font-medium text-amber-400">Install this harness</p>
      <Show when={command()}>
        {(cmd) => (
          <div class="flex items-center gap-1.5 rounded bg-background/60 px-2 py-1">
            <code class="flex-1 truncate font-mono text-[10px] text-foreground" title={cmd()}>
              {cmd()}
            </code>
            <button
              type="button"
              class="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-foreground transition-colors hover:bg-accent"
              onClick={() => void handleCopy()}
            >
              {copied() ? "Copied" : "Copy"}
            </button>
          </div>
        )}
      </Show>
      <Show when={props.docsUrl}>
        {(url) => (
          <button
            type="button"
            class="self-start rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300 transition-colors hover:bg-amber-500/20 disabled:pointer-events-none disabled:opacity-50"
            onClick={() => void handleOpenDocs()}
            disabled={openingDocs()}
          >
            {openingDocs() ? "Opening…" : `Open install docs ↗`}
            <span class="sr-only"> — {url()}</span>
          </button>
        )}
      </Show>
    </div>
  );
};

const HarnessesSection: Component<{ active: boolean }> = (props) => {
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

  // Re-probe in the background only when the user actually navigates to this
  // section. The cached value from `harnessStatusStore` (populated at app
  // boot) is shown instantly. We skip if the initial boot probe is still in
  // flight — its result is already fresh enough.
  createEffect(() => {
    if (props.active && !harnessReport.loading) {
      void refreshHarnessReport();
    }
  });

  const statusFor = (id: HarnessIconKind): HarnessStatus | undefined =>
    harnessReport()?.harnesses.find((h) => h.kind === id);

  const [localFlags, setLocalFlags] = createSignal<Record<string, string>>({});
  const [seeded, setSeeded] = createSignal(false);
  const [refreshing, setRefreshing] = createSignal(false);

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

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshHarnessReport();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-start justify-between gap-3">
        <p class="text-[10px] text-muted-foreground">
          Status of each harness binary on $PATH, plus any extra flags raum appends when spawning.
        </p>
        <button
          type="button"
          class="shrink-0 rounded border border-border bg-background px-2 py-0.5 text-[10px] text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          onClick={handleRefresh}
          disabled={refreshing() || harnessReport.loading}
        >
          {refreshing() || harnessReport.loading ? "Checking…" : "Recheck"}
        </button>
      </div>
      <div class="flex flex-col gap-2">
        <For each={HARNESS_ENTRIES}>
          {(entry) => {
            const Icon = HARNESS_ICONS[entry.id];
            const status = () => statusFor(entry.id);
            return (
              <div class="overflow-hidden rounded border border-border bg-card/30">
                {/* Header row */}
                <div class="flex items-start gap-2.5 border-b border-border/50 px-3 py-2.5">
                  <div class="flex size-6 shrink-0 items-center justify-center rounded border border-border/60 bg-background">
                    <Icon class="size-3.5 text-foreground" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="text-xs font-medium text-foreground">{entry.label}</p>
                    <p class="text-[10px] text-muted-foreground">
                      {entry.binary} · {entry.description}
                    </p>
                  </div>
                  <div class="shrink-0 pt-0.5">
                    <HarnessStatusBadge status={status()} />
                  </div>
                </div>

                {/* Status details */}
                <div class="flex flex-col gap-1 border-b border-border/50 px-3 py-2">
                  {/* Version line */}
                  <div class="flex items-baseline justify-between gap-3">
                    <span class="text-[9px] uppercase tracking-wider text-muted-foreground/60">
                      Version
                    </span>
                    <Show
                      when={status()}
                      fallback={<span class="text-[10px] text-muted-foreground">—</span>}
                    >
                      {(s) => (
                        <Show
                          when={s().found}
                          fallback={<span class="text-[10px] text-muted-foreground">—</span>}
                        >
                          <span
                            class="truncate font-mono text-[10px] text-foreground"
                            title={s().raw ?? undefined}
                          >
                            {s().version ?? s().raw ?? "unknown"}
                          </span>
                        </Show>
                      )}
                    </Show>
                  </div>

                  {/* Minimum version line (only when we have one) */}
                  <Show when={status()?.minimum}>
                    {(min) => (
                      <div class="flex items-baseline justify-between gap-3">
                        <span class="text-[9px] uppercase tracking-wider text-muted-foreground/60">
                          Minimum
                        </span>
                        <span
                          class={cx(
                            "font-mono text-[10px]",
                            status()?.meetsMinimum === false
                              ? "text-amber-400"
                              : "text-muted-foreground",
                          )}
                        >
                          {min()}
                          <Show when={status()?.meetsMinimum === false}>
                            {" "}
                            <span class="text-amber-400">· below minimum</span>
                          </Show>
                        </span>
                      </div>
                    )}
                  </Show>

                  {/* Resolved path line (only when found) */}
                  <Show when={status()?.found && status()?.resolvedPath}>
                    {(path) => (
                      <div class="flex items-baseline justify-between gap-3">
                        <span class="shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground/60">
                          Path
                        </span>
                        <span
                          class="min-w-0 truncate text-right font-mono text-[10px] text-muted-foreground"
                          title={path()}
                        >
                          {path()}
                        </span>
                      </div>
                    )}
                  </Show>

                  {/* Hook config line (only when applicable) */}
                  <Show when={status()?.settingsPath}>
                    {(settingsPath) => (
                      <div class="flex items-baseline justify-between gap-3">
                        <span class="shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground/60">
                          Hooks
                        </span>
                        <span
                          class="min-w-0 truncate text-right font-mono text-[10px] text-muted-foreground"
                          title={settingsPath()}
                        >
                          {settingsPath()}
                        </span>
                      </div>
                    )}
                  </Show>

                  {/* Native events indicator */}
                  <Show when={status()?.supportsNativeEvents}>
                    <div class="flex items-baseline justify-between gap-3">
                      <span class="text-[9px] uppercase tracking-wider text-muted-foreground/60">
                        Events
                      </span>
                      <span class="text-[10px] text-muted-foreground">Native hooks supported</span>
                    </div>
                  </Show>

                  {/* Install action when missing (only for harnesses we can install) */}
                  <Show when={status() && !status()!.found && INSTALL_COMMANDS[entry.id]}>
                    <InstallPanel kind={entry.id} docsUrl={status()?.installHint ?? null} />
                  </Show>
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
// Updates section
// ---------------------------------------------------------------------------

type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; checkedAt: number }
  | { kind: "available"; update: Update }
  | {
      kind: "downloading";
      update: Update;
      received: number;
      total: number | null;
    }
  | { kind: "installed"; version: string }
  | { kind: "error"; message: string };

const UpdatesSection: Component = () => {
  const [currentVersion] = createResource<string>(async () => {
    try {
      return await getVersion();
    } catch {
      return "unknown";
    }
  });

  const [initialPref] = createResource<boolean>(async () => {
    try {
      const cfg = await invoke<{ updater?: { check_on_launch?: boolean } }>("config_get");
      return cfg.updater?.check_on_launch ?? true;
    } catch {
      return true;
    }
  });

  const [checkOnLaunch, setCheckOnLaunch] = createSignal(true);
  const [prefSeeded, setPrefSeeded] = createSignal(false);
  const [prefSaving, setPrefSaving] = createSignal(false);

  createEffect(() => {
    const v = initialPref();
    if (v !== undefined && !prefSeeded()) {
      setCheckOnLaunch(v);
      setPrefSeeded(true);
    }
  });

  const handlePrefToggle = async (v: boolean) => {
    setCheckOnLaunch(v);
    setPrefSaving(true);
    try {
      await invoke("config_set_updater_check_on_launch", { enabled: v });
    } catch (e) {
      console.warn("config_set_updater_check_on_launch failed", e);
    } finally {
      setPrefSaving(false);
    }
  };

  const [phase, setPhase] = createSignal<UpdatePhase>({ kind: "idle" });

  const runCheck = async () => {
    setPhase({ kind: "checking" });
    try {
      const update = await checkForUpdate();
      if (!update) {
        setPhase({ kind: "up-to-date", checkedAt: Date.now() });
        return;
      }
      setPhase({ kind: "available", update });
    } catch (e) {
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const runInstall = async () => {
    const p = phase();
    if (p.kind !== "available") return;
    const { update } = p;
    setPhase({ kind: "downloading", update, received: 0, total: null });
    try {
      let received = 0;
      let total: number | null = null;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = typeof event.data.contentLength === "number" ? event.data.contentLength : null;
          setPhase({ kind: "downloading", update, received: 0, total });
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          setPhase({ kind: "downloading", update, received, total });
        }
      });
      setPhase({ kind: "installed", version: update.version });
    } catch (e) {
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const primaryLabel = () => {
    const p = phase();
    switch (p.kind) {
      case "checking":
        return "Checking…";
      case "downloading":
        return "Installing…";
      case "up-to-date":
      case "available":
      case "installed":
        return "Check again";
      case "error":
        return "Try again";
      default:
        return "Check for updates";
    }
  };

  const progressPct = () => {
    const p = phase();
    if (p.kind !== "downloading") return null;
    if (p.total == null || p.total === 0) return null;
    return Math.min(100, Math.round((p.received / p.total) * 100));
  };

  const isBusy = () => {
    const k = phase().kind;
    return k === "checking" || k === "downloading";
  };

  return (
    <div class="flex flex-col gap-4">
      {/* Current version */}
      <div class="flex flex-col gap-1.5">
        <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">Installed</h4>
        <div class="flex items-center justify-between rounded border border-border bg-card/30 px-3 py-2">
          <div class="min-w-0 flex-1">
            <p class="text-xs text-foreground">Current version</p>
            <p class="text-[10px] text-muted-foreground">
              raum is distributed as signed macOS DMGs and Linux AppImage/.deb bundles.
            </p>
          </div>
          <code class="shrink-0 rounded bg-background px-2 py-0.5 font-mono text-[11px] text-foreground">
            {currentVersion() ?? "…"}
          </code>
        </div>
      </div>

      {/* Check + install */}
      <div class="flex flex-col gap-1.5">
        <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">Updates</h4>
        <div class="flex flex-col gap-2 rounded border border-border bg-card/30 px-3 py-2">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0 flex-1">
              <Show when={phase().kind === "idle" || phase().kind === "checking"}>
                <p class="text-xs text-foreground">
                  {phase().kind === "checking"
                    ? "Contacting GitHub Releases…"
                    : "Check for a newer build."}
                </p>
                <p class="text-[10px] text-muted-foreground">
                  Signed releases only — the public key in tauri.conf.json verifies each bundle.
                </p>
              </Show>
              <Show when={phase().kind === "up-to-date"}>
                <p class="text-xs text-emerald-400">raum is up to date.</p>
                <p class="text-[10px] text-muted-foreground">
                  You're running the latest published release.
                </p>
              </Show>
              <Show when={phase().kind === "available"}>
                {(() => {
                  const p = phase();
                  if (p.kind !== "available") return null;
                  return (
                    <>
                      <p class="text-xs text-foreground">
                        Update available:{" "}
                        <span class="font-mono text-amber-400">{p.update.version}</span>
                      </p>
                      <p class="text-[10px] text-muted-foreground">
                        Released {p.update.date ?? "recently"}. Click "Install" to download and
                        apply; raum will ask you to relaunch.
                      </p>
                    </>
                  );
                })()}
              </Show>
              <Show when={phase().kind === "downloading"}>
                {(() => {
                  const p = phase();
                  if (p.kind !== "downloading") return null;
                  const pct = progressPct();
                  return (
                    <>
                      <p class="text-xs text-foreground">
                        Downloading {p.update.version}
                        {pct !== null ? ` — ${pct}%` : "…"}
                      </p>
                      <div class="mt-1 h-1 w-full overflow-hidden rounded bg-background">
                        <div
                          class="h-full bg-primary transition-[width]"
                          style={{
                            width: pct !== null ? `${pct}%` : "30%",
                          }}
                        />
                      </div>
                    </>
                  );
                })()}
              </Show>
              <Show when={phase().kind === "installed"}>
                {(() => {
                  const p = phase();
                  if (p.kind !== "installed") return null;
                  return (
                    <>
                      <p class="text-xs text-emerald-400">
                        Installed {p.version}. Relaunch raum to finish.
                      </p>
                      <p class="text-[10px] text-muted-foreground">
                        Quit raum (⌘Q) and reopen; tmux sessions survive the restart.
                      </p>
                    </>
                  );
                })()}
              </Show>
              <Show when={phase().kind === "error"}>
                {(() => {
                  const p = phase();
                  if (p.kind !== "error") return null;
                  return (
                    <>
                      <p class="text-xs text-red-400">Update failed</p>
                      <p class="text-[10px] text-muted-foreground" title={p.message}>
                        {p.message}
                      </p>
                    </>
                  );
                })()}
              </Show>
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              <Show when={phase().kind === "available"}>
                <button
                  type="button"
                  class="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300 transition-colors hover:bg-amber-500/20 disabled:pointer-events-none disabled:opacity-50"
                  onClick={() => void runInstall()}
                  disabled={isBusy()}
                >
                  Install
                </button>
              </Show>
              <button
                type="button"
                class="rounded border border-border bg-background px-2 py-0.5 text-[10px] text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                onClick={() => void runCheck()}
                disabled={isBusy()}
              >
                {primaryLabel()}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Preference */}
      <div class="flex flex-col gap-1.5">
        <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">Behaviour</h4>
        <div class="flex flex-col gap-1">
          <ToggleRow
            label="Check for updates on launch"
            description="Quietly checks GitHub Releases a few seconds after raum opens."
            checked={prefSeeded() ? checkOnLaunch() : true}
            onChange={(v) => void handlePrefToggle(v)}
            disabled={prefSaving() || !prefSeeded()}
          />
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Section router
// ---------------------------------------------------------------------------

/**
 * Both sections are always mounted while the modal is open and toggled via
 * `hidden`. Mounting either section the first time involves a non-trivial
 * amount of JSX (4 harness cards, multiple `<Show>` blocks, text inputs) and
 * an IPC round-trip — doing that work on every tab click made switching feel
 * laggy. Paying it once on modal open keeps subsequent tab switches at the
 * cost of a CSS class flip.
 */
const SectionContent: Component<{ section: SectionId }> = (props) => {
  return (
    <>
      <div class={cx(props.section === "notifications" ? "" : "hidden")}>
        <NotificationsSection />
      </div>
      <div class={cx(props.section === "harnesses" ? "" : "hidden")}>
        <HarnessesSection active={props.section === "harnesses"} />
      </div>
      <div class={cx(props.section === "updates" ? "" : "hidden")}>
        <UpdatesSection />
      </div>
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
          class="floating-surface data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95 fixed top-[50%] left-[50%] z-50 flex w-full max-w-2xl translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-2xl border border-border bg-popover duration-200 focus:outline-none"
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
