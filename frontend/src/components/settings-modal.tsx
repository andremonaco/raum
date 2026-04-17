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
import { Component, For, Show, createEffect, createResource, createSignal, on } from "solid-js";
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
  harnessHealth,
  harnessReport,
  refreshHarnessReport,
  type HarnessStatus,
} from "../stores/harnessStatusStore";
import { openUrl } from "@tauri-apps/plugin-opener";

import { CheckIcon, HARNESS_ICONS, LoaderIcon, PlayIcon, type HarnessIconKind } from "./icons";
import { Scrollable } from "./ui/scrollable";
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

type SectionId = "notifications" | "harnesses" | "health" | "worktrees" | "updates";

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
    id: "health",
    label: "Harness Health",
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
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    ),
  },
  {
    id: "worktrees",
    label: "Worktrees",
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
        {/* git-branch-ish icon: two nodes connected by a curve. */}
        <circle cx="6" cy="6" r="2" />
        <circle cx="6" cy="18" r="2" />
        <circle cx="18" cy="8" r="2" />
        <path d="M6 8v8" />
        <path d="M18 10c0 4-4 4-6 4H8" />
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

const HarnessStatusBadge: Component<{
  status: HarnessStatus | undefined;
  loading: boolean;
}> = (props) => {
  // While the probe is in flight we hide any stale cached status and show a
  // spinner — navigating to the Harnesses section always re-probes, and the
  // user's expectation is "see loading, then see result".
  const resolved = () => (props.loading ? undefined : props.status);
  return (
    <Show
      when={resolved()}
      fallback={
        <span
          class="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-muted/30 text-muted-foreground"
          title="Checking…"
          aria-label="Checking"
        >
          <LoaderIcon class="size-2.5 animate-spin" />
        </span>
      }
    >
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
  // flight — its result is already fresh enough. `on` tracks only
  // `props.active`; reading `loading` inside is untracked so the completing
  // probe cannot re-trigger this effect into an infinite refetch loop.
  createEffect(
    on(
      () => props.active,
      (active) => {
        if (active && !harnessReport.loading) {
          void refreshHarnessReport();
        }
      },
    ),
  );

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
                    <HarnessStatusBadge status={status()} loading={harnessReport.loading} />
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
// Worktrees section
// ---------------------------------------------------------------------------

const WORKTREE_PRESETS = {
  inside: "{repo-root}/.raum/{worktree-slug}",
  sibling: "{parent-dir}/{repo-name}-worktrees/{worktree-slug}",
} as const;

type WorktreePresetKey = keyof typeof WORKTREE_PRESETS | "custom";

interface ProjectListItem {
  slug: string;
  name: string;
  rootPath: string;
}

/** Mirror of `slug::slugify` just close enough for a live preview. The real
 *  slugging happens in Rust at worktree-create time. */
function slugifyForPreview(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Pure-frontend mirror of `preview_path_pattern` in
 *  `crates/raum-hydration/src/pattern.rs`. Used so the settings preview stays
 *  responsive while the user types without round-tripping through a Tauri
 *  command that reads the stored pattern. */
function renderPathPreview(pattern: string, rootPath: string, branch: string): string {
  const norm = rootPath.replace(/\/+$/, "");
  const lastSlash = norm.lastIndexOf("/");
  const parentDir = lastSlash > 0 ? norm.slice(0, lastSlash) : "";
  const baseFolder = lastSlash >= 0 ? norm.slice(lastSlash + 1) : norm || "project";
  const branchSlug = slugifyForPreview(branch);
  return pattern
    .replace(/\{repo-root\}/g, norm)
    .replace(/\{repo-name\}/g, baseFolder)
    .replace(/\{worktree-slug\}/g, branchSlug)
    .replace(/\{parent-dir\}/g, parentDir)
    .replace(/\{base-folder\}/g, baseFolder)
    .replace(/\{branch-slug\}/g, branchSlug)
    .replace(/\{branch-name\}/g, branch)
    .replace(/\{project-slug\}/g, baseFolder);
}

function detectPreset(pattern: string): WorktreePresetKey {
  if (pattern === WORKTREE_PRESETS.inside) return "inside";
  if (pattern === WORKTREE_PRESETS.sibling) return "sibling";
  return "custom";
}

const WorktreesSection: Component<{ active: boolean }> = (props) => {
  const [pattern, setPattern] = createSignal<string>(WORKTREE_PRESETS.sibling);
  const [customDraft, setCustomDraft] = createSignal<string>(WORKTREE_PRESETS.sibling);
  const [preset, setPreset] = createSignal<WorktreePresetKey>("sibling");
  const [saving, setSaving] = createSignal(false);
  const [seeded, setSeeded] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | undefined>(undefined);

  // Seed from config when the section mounts (runs once because the modal
  // keeps sections mounted and toggles visibility via `hidden`).
  void (async () => {
    try {
      const cfg = await invoke<{ worktreeConfig?: { pathPattern?: string } }>("config_get");
      const p = cfg.worktreeConfig?.pathPattern?.trim();
      const effective = p && p.length > 0 ? p : WORKTREE_PRESETS.sibling;
      setPattern(effective);
      setCustomDraft(effective);
      setPreset(detectPreset(effective));
    } catch {
      // leave defaults — invalid config shouldn't block the UI.
    } finally {
      setSeeded(true);
    }
  })();

  const [projects] = createResource<ProjectListItem[]>(async () => {
    try {
      return await invoke<ProjectListItem[]>("project_list");
    } catch {
      return [];
    }
  });

  const previewProject = () => projects()?.[0];
  const previewRoot = () => previewProject()?.rootPath ?? "/Users/you/example-project";
  const previewBranch = "feat/new-darkmode";

  const previewPath = () => renderPathPreview(pattern(), previewRoot(), previewBranch);

  async function persist(next: string) {
    setSaving(true);
    setSaveError(undefined);
    try {
      const stored = await invoke<string>("config_set_worktree_path_pattern", {
        pattern: next,
      });
      // Backend echoes the effective pattern (e.g. empty → built-in default).
      // Re-sync if the stored value differs from what the UI sent.
      if (stored !== next) {
        setPattern(stored);
        setCustomDraft(stored);
        setPreset(detectPreset(stored));
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function selectPreset(next: WorktreePresetKey) {
    setPreset(next);
    if (next === "custom") {
      // Don't persist yet — wait for the user to edit + blur. Seed the draft
      // from the currently-stored pattern so they can tweak rather than start
      // from scratch.
      setCustomDraft(pattern());
      return;
    }
    const p = WORKTREE_PRESETS[next];
    setPattern(p);
    setCustomDraft(p);
    void persist(p);
  }

  function commitCustom() {
    const next = customDraft().trim();
    if (!next) return;
    if (next === pattern()) return;
    setPattern(next);
    void persist(next);
  }

  // Watch the modal becoming active — re-check projects so a project added
  // while the modal was closed still shows up in the preview.
  createEffect(
    on(
      () => props.active,
      (active) => {
        if (active) {
          void invoke<ProjectListItem[]>("project_list")
            .then(() => {
              /* triggers resource refetch next read */
            })
            .catch(() => {});
        }
      },
    ),
  );

  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">
          Worktree location
        </h4>
        <p class="text-[10px] text-muted-foreground">
          Where raum puts new git worktrees. Tokens are substituted at create time.
        </p>
        <div class="flex flex-col gap-1.5">
          <PresetRow
            checked={preset() === "inside"}
            disabled={!seeded() || saving()}
            title="Inside the project"
            description="Lives under a .raum/ folder at the project root. raum adds .raum/ to .gitignore the first time you use this."
            pattern={WORKTREE_PRESETS.inside}
            onSelect={() => selectPreset("inside")}
          />
          <PresetRow
            checked={preset() === "sibling"}
            disabled={!seeded() || saving()}
            title="Sibling folder"
            description="Dropped next to the project in a <name>-worktrees/ directory. This is the default."
            pattern={WORKTREE_PRESETS.sibling}
            onSelect={() => selectPreset("sibling")}
          />
          <PresetRow
            checked={preset() === "custom"}
            disabled={!seeded() || saving()}
            title="Custom"
            description="Write your own pattern using the tokens below."
            pattern={preset() === "custom" ? customDraft() : "…"}
            onSelect={() => selectPreset("custom")}
          />
        </div>
      </div>

      <Show when={preset() === "custom"}>
        <div class="flex flex-col gap-1.5">
          <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">Custom pattern</h4>
          <input
            type="text"
            class="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground focus:border-ring focus:outline-none disabled:opacity-50"
            placeholder="{repo-root}/.raum/{worktree-slug}"
            value={customDraft()}
            onInput={(e) => setCustomDraft(e.currentTarget.value)}
            onBlur={commitCustom}
            disabled={saving()}
          />
          <p class="text-[10px] text-muted-foreground">
            Tokens: <code class="rounded bg-muted px-1 py-px font-mono">{"{repo-root}"}</code>,{" "}
            <code class="rounded bg-muted px-1 py-px font-mono">{"{repo-name}"}</code>,{" "}
            <code class="rounded bg-muted px-1 py-px font-mono">{"{parent-dir}"}</code>,{" "}
            <code class="rounded bg-muted px-1 py-px font-mono">{"{worktree-slug}"}</code>,{" "}
            <code class="rounded bg-muted px-1 py-px font-mono">{"{branch-name}"}</code>.
          </p>
        </div>
      </Show>

      <div class="flex flex-col gap-1.5">
        <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">Preview</h4>
        <div class="rounded border border-border bg-card/30 px-3 py-2">
          <p class="text-[10px] text-muted-foreground">
            Example for branch{" "}
            <code class="rounded bg-muted px-1 py-px font-mono">{previewBranch}</code>
            <Show
              when={previewProject()}
              fallback={<> in a hypothetical project (no projects registered yet)</>}
            >
              {" "}
              in {previewProject()?.name}
            </Show>
            :
          </p>
          <p class="mt-1 truncate font-mono text-xs text-foreground" data-testid="worktree-preview">
            {previewPath()}
          </p>
        </div>
      </div>

      <Show when={saveError()}>
        <div class="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-[10px] text-red-300">
          {saveError()}
        </div>
      </Show>
    </div>
  );
};

const PresetRow: Component<{
  checked: boolean;
  disabled?: boolean;
  title: string;
  description: string;
  pattern: string;
  onSelect: () => void;
}> = (props) => {
  return (
    <button
      type="button"
      onClick={() => !props.disabled && props.onSelect()}
      disabled={props.disabled}
      class={cx(
        "flex items-start gap-2 rounded border px-3 py-2 text-left transition-colors disabled:pointer-events-none disabled:opacity-50",
        props.checked
          ? "border-primary/60 bg-primary/10"
          : "border-border bg-card/30 hover:bg-accent/50",
      )}
    >
      <span
        class={cx(
          "mt-0.5 block size-3 shrink-0 rounded-full border-2",
          props.checked ? "border-primary bg-primary" : "border-muted-foreground/40",
        )}
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1">
        <p class="text-xs text-foreground">{props.title}</p>
        <p class="text-[10px] text-muted-foreground">{props.description}</p>
        <p class="mt-1 truncate font-mono text-[10px] text-muted-foreground/80">{props.pattern}</p>
      </div>
    </button>
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
/**
 * Harness Health panel (Phase 2 scaffold).
 *
 * Renders a per-harness summary of channel reliability + the latest
 * selftest result. This panel is intentionally minimal in Phase 2 —
 * Phase 3/4 will plug the backend `plan`/`selftest` commands in; for
 * now it reads from `harnessHealth()` which is populated on demand by
 * the rest of the app.
 */
const HealthSection: Component = () => {
  const entries = () => Object.values(harnessHealth());
  return (
    <div class="flex flex-col gap-3">
      <p class="text-xs text-zinc-400">
        Channel + selftest status for every bound harness. Reliability badges mirror what the dock
        renders on the Waiting state.
      </p>
      <Show
        when={entries().length > 0}
        fallback={
          <div class="rounded border border-dashed border-zinc-800 bg-zinc-900/40 p-3 text-[11px] text-zinc-500">
            No health data yet. Bind a harness to a project to populate this panel.
          </div>
        }
      >
        <ul class="flex flex-col gap-2">
          <For each={entries()}>
            {(entry) => {
              const kind = entry.kind;
              const Icon = HARNESS_ICONS[kind as keyof typeof HARNESS_ICONS];
              return (
                <li class="rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-[11px]">
                  <div class="flex items-center gap-2">
                    <Show when={Icon}>{Icon ? <Icon class="size-3" /> : null}</Show>
                    <span class="font-medium text-zinc-200">{kind}</span>
                    <span class="ml-auto text-[10px] text-zinc-500">
                      {entry.setupOk == null
                        ? "setup pending"
                        : entry.setupOk
                          ? "setup ok"
                          : "setup degraded"}
                    </span>
                  </div>
                  <Show when={entry.setup && entry.setup.length > 0}>
                    <ul class="mt-1 ml-5 list-disc text-[10px] text-zinc-400">
                      <For each={entry.setup!}>
                        {(a) => (
                          <li>
                            <span
                              class={
                                a.outcome === "failed"
                                  ? "text-red-400"
                                  : a.outcome === "skipped"
                                    ? "text-amber-400"
                                    : "text-emerald-400"
                              }
                            >
                              {a.outcome}
                            </span>{" "}
                            <span class="text-zinc-500">{a.actionKind}</span>
                            <Show when={a.detail}>
                              {(d) => <span class="text-zinc-600"> — {d()}</span>}
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                  <Show when={entry.selftest}>
                    {(st) => (
                      <div class="mt-1 flex items-center gap-2 text-[10px] text-zinc-400">
                        <span class={st().ok ? "text-emerald-400" : "text-red-400"}>
                          selftest {st().ok ? "ok" : "failed"}
                        </span>
                        <span class="text-zinc-600">— {st().detail}</span>
                        <span class="ml-auto text-zinc-600">{st().elapsedMs} ms</span>
                      </div>
                    )}
                  </Show>
                  <button
                    type="button"
                    class="mt-2 rounded border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
                    onClick={() => void refreshHarnessReport()}
                  >
                    Run again
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </div>
  );
};

const SectionContent: Component<{ section: SectionId }> = (props) => {
  return (
    <>
      <div class={cx(props.section === "notifications" ? "" : "hidden")}>
        <NotificationsSection />
      </div>
      <div class={cx(props.section === "harnesses" ? "" : "hidden")}>
        <HarnessesSection active={props.section === "harnesses"} />
      </div>
      <div class={cx(props.section === "health" ? "" : "hidden")}>
        <HealthSection />
      </div>
      <div class={cx(props.section === "worktrees" ? "" : "hidden")}>
        <WorktreesSection active={props.section === "worktrees"} />
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
              <Scrollable class="min-h-0 flex-1 px-1.5 pb-1.5">
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
              </Scrollable>
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
              <Scrollable class="min-h-0 flex-1 px-4 py-4">
                <SectionContent section={activeSection()} />
              </Scrollable>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive>
  );
};
