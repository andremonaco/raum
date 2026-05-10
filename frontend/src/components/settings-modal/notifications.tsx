import { Component, For, Show, createEffect, createResource, createSignal, on } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

import { cx } from "~/lib/cva";
import {
  type BadgeMode,
  notificationBundleId,
  notificationDevMode,
  notificationStateNote,
  openNotificationSystemSettings,
  permissionState,
  previewSound,
  refreshNotificationAuthorization,
  refreshNotificationConfig,
  sendTestNotification,
} from "../../lib/notificationCenter";
import { harnessHealth, scanHarnessInstallState } from "../../stores/harnessStatusStore";
import { activeProjectSlug, projectStore } from "../../stores/projectStore";

import { CheckIcon, HARNESS_ICONS, PlayIcon, RaumLogo, type HarnessIconKind } from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

import { PermissionBadge, StatusPill, ToggleRow } from "./shared";
import { BADGE_MODE_OPTIONS, CUSTOM_SOUND_VALUE, HARNESS_ENTRIES } from "./constants";
import type { NotifConfig, NotifOsInfo, SystemSound } from "./types";
import { isBadgeMode, notificationReadinessLabel, pathsReady } from "./utils";

/**
 * Compact per-harness summary rendered inside the Notifications section.
 * Shows one row per harness that has an event surface (all except shell)
 * with a ready/not-ready pill derived from the shared scan in
 * `harnessStatusStore`. The full install / troubleshooting UI lives in the
 * Harnesses section; this view is intentionally read-only.
 */
const HarnessNotificationsSummary: Component = () => {
  const activeProjectRoot = () => {
    const slug = activeProjectSlug();
    if (!slug) return null;
    return projectStore.items.find((p) => p.slug === slug)?.rootPath ?? null;
  };

  void scanHarnessInstallState(activeProjectRoot());

  const rowTone = (kind: HarnessIconKind): "ok" | "warn" | "error" | "muted" => {
    const scan = harnessHealth()[kind]?.scan ?? null;
    if (!scan) return "muted";
    if (!pathsReady(scan)) return "error";
    if (permissionState() !== "granted") return "warn";
    return "ok";
  };

  const rowLabel = (kind: HarnessIconKind): string => {
    const scan = harnessHealth()[kind]?.scan ?? null;
    if (!scan) return "Scanning…";
    if (!pathsReady(scan)) return "Not configured";
    return notificationReadinessLabel();
  };

  return (
    <div class="flex flex-col gap-1.5">
      <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">Per harness</h4>
      <div class="flex flex-col divide-y divide-border/50 rounded border border-border bg-card/30">
        <For each={HARNESS_ENTRIES.filter((e) => e.id !== "shell")}>
          {(entry) => {
            const Icon = HARNESS_ICONS[entry.id];
            return (
              <div class="flex items-center gap-2 px-3 py-2">
                <Icon class="size-3.5 shrink-0 text-foreground" />
                <span class="text-xs text-foreground">{entry.label}</span>
                <span class="ml-auto">
                  <StatusPill tone={rowTone(entry.id)}>{rowLabel(entry.id)}</StatusPill>
                </span>
              </div>
            );
          }}
        </For>
      </div>
      <p class="text-[10px] text-muted-foreground">
        Configure or reinstall each harness from Settings → Harnesses.
      </p>
    </div>
  );
};

/**
 * Mock dock icon with a Slack-style count badge. Used in Settings →
 * Notifications → Delivery so macOS users can see what the "Dock badge"
 * selector actually does to their dock icon. Purely presentational — no
 * state, no IPC. The count + accent colour track `mode`:
 *   • off         → no badge bubble at all (dimmed icon tile)
 *   • critical    → amber bubble, single "1" (represents a pending perm)
 *   • all_unread  → red bubble, "3" (represents several unread agents)
 */
const DockBadgePreview: Component<{ mode: BadgeMode }> = (props) => {
  const showBadge = () => props.mode !== "off";
  const badgeCount = () => (props.mode === "critical" ? "1" : "3");
  const badgeTone = () =>
    props.mode === "critical" ? "bg-amber-500 text-amber-950" : "bg-red-500 text-white";

  return (
    <div
      class={cx(
        "relative flex size-[64px] shrink-0 items-center justify-center rounded-[14px] border border-border bg-gradient-to-br from-card to-background shadow-sm transition-opacity",
        props.mode === "off" && "opacity-60",
      )}
      aria-hidden="true"
    >
      <RaumLogo class="size-9 text-foreground" />
      <Show when={showBadge()}>
        <span
          class={cx(
            "absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full text-[10px] font-semibold shadow ring-2 ring-background",
            badgeTone(),
          )}
        >
          {badgeCount()}
        </span>
      </Show>
    </div>
  );
};

/**
 * Mock macOS-style notification banner. Used alongside the "Show
 * notification banners" toggle so users can see the exact thing they are
 * enabling or disabling. Dims + grayscales when `enabled` is false, with
 * a muted "Banners are off" overlay label. Purely presentational.
 */
const NotificationBannerPreview: Component<{ enabled: boolean }> = (props) => {
  return (
    <div
      class={cx(
        "relative flex w-full max-w-[280px] items-start gap-2.5 rounded-xl border border-border bg-card/70 p-2.5 shadow-sm backdrop-blur transition-all",
        !props.enabled && "opacity-40 grayscale",
      )}
      aria-hidden="true"
    >
      <div class="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
        <RaumLogo class="size-5 text-foreground" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-1.5">
          <span class="text-[10px] font-medium text-foreground">raum</span>
          <span class="truncate text-[9px] text-muted-foreground">now</span>
        </div>
        <p class="mt-0.5 truncate text-[11px] font-semibold text-foreground">α raum</p>
        <p class="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">Claude needs you.</p>
      </div>
      <Show when={!props.enabled}>
        <span class="pointer-events-none absolute inset-x-0 bottom-1 text-center text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
          Banners are off
        </span>
      </Show>
    </div>
  );
};

export const NotificationsSection: Component<{ active: boolean; open: boolean }> = (props) => {
  const [config] = createResource<NotifConfig>(async () => {
    const cfg = await invoke<{
      notifications?: {
        notify_on_waiting?: boolean;
        notify_on_done?: boolean;
        notify_banner_enabled?: boolean;
        sound?: string | null;
        badge_mode?: string;
      };
    }>("config_get");
    const rawBadgeMode = cfg.notifications?.badge_mode;
    return {
      notify_on_waiting: cfg.notifications?.notify_on_waiting ?? true,
      notify_on_done: cfg.notifications?.notify_on_done ?? true,
      notify_banner_enabled: cfg.notifications?.notify_banner_enabled ?? true,
      sound: cfg.notifications?.sound ?? null,
      badge_mode: isBadgeMode(rawBadgeMode) ? rawBadgeMode : "all_unread",
    };
  });

  // Platform detection controls whether the Dock badge subsection is
  // rendered. Tauri's `set_badge_count` only reliably hits the macOS dock;
  // on Linux it targets the Unity launcher protocol, which GNOME Shell —
  // the dominant DE — does not implement. Rather than surface a toggle
  // that silently no-ops, we hide the subsection entirely off-macOS.
  const [osInfo] = createResource<NotifOsInfo>(() =>
    invoke<NotifOsInfo>("os_info").catch(() => ({ family: "other" as const })),
  );
  const isMacos = () => osInfo()?.family === "macos";

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
  const [localBannerEnabled, setLocalBannerEnabled] = createSignal(true);
  // The on-disk sound path stored in config. "" means no sound.
  const [localSound, setLocalSound] = createSignal("");
  const [localBadgeMode, setLocalBadgeMode] = createSignal<BadgeMode>("all_unread");
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
      setLocalBannerEnabled(c.notify_banner_enabled);
      setLocalBadgeMode(c.badge_mode);
      const path = c.sound ?? "";
      setLocalSound(path);
      // If a path is set and it doesn't match any discovered system sound,
      // open the dropdown in custom mode so the text input is visible.
      const matchesSystem = path !== "" && sounds.some((s) => s.path === path);
      setCustomMode(path !== "" && !matchesSystem);
      setSeeded(true);
    }
  });

  const saveConfig = async (patch: {
    waiting?: boolean;
    done?: boolean;
    bannerEnabled?: boolean;
    sound?: string;
    badgeMode?: BadgeMode;
  }) => {
    setSaving(true);
    try {
      await invoke("config_set_notifications", {
        notifyOnWaiting: patch.waiting ?? localWaiting(),
        notifyOnDone: patch.done ?? localDone(),
        notifyBannerEnabled: patch.bannerEnabled ?? localBannerEnabled(),
        sound: (patch.sound ?? localSound()) || null,
        badgeMode: patch.badgeMode ?? localBadgeMode(),
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

  const handleBannerToggle = async (v: boolean) => {
    setLocalBannerEnabled(v);
    await saveConfig({ bannerEnabled: v });
  };

  const handleBadgeModeSelect = async (value: BadgeMode) => {
    setLocalBadgeMode(value);
    await saveConfig({ badgeMode: value });
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

  const handleOpenOsSettings = async () => {
    await openNotificationSystemSettings();
    window.setTimeout(() => void refreshNotificationAuthorization(), 1500);
  };

  createEffect(
    on(
      () => props.active && props.open,
      (visible) => {
        if (!visible) return;
        void refreshNotificationAuthorization();
      },
    ),
  );

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
            <button
              type="button"
              class="rounded border border-border bg-background px-2 py-0.5 text-[10px] text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              onClick={handleOpenOsSettings}
              disabled={saving()}
              title="Open macOS / Linux notification settings"
            >
              Open Settings
            </button>
            <button
              type="button"
              class="rounded border border-border bg-background px-2 py-0.5 text-[10px] text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              onClick={() => void sendTestNotification()}
              title="Send a test notification to verify it reaches you."
            >
              Send test
            </button>
          </div>
        </div>
        <Show when={notificationStateNote()}>
          <p class="rounded border border-warning/30 bg-warning/10 px-2 py-1 text-[10px] text-warning">
            {notificationStateNote()}
          </p>
        </Show>
        <Show when={notificationBundleId() && !notificationDevMode()}>
          <p class="text-[10px] text-muted-foreground">
            Authorization checked for <code>{notificationBundleId()}</code>.
          </p>
        </Show>
      </div>

      {/* Per-harness notification readiness (read-only). */}
      <HarnessNotificationsSummary />

      {/* Delivery — two delivery channels (OS banner + dock badge) with
          live preview mocks so users can see exactly what each toggle
          controls. The dock-badge subsection is hidden entirely on
          non-macOS because Tauri's set_badge_count does not reliably
          target GNOME Shell. */}
      <div class="flex flex-col gap-1.5">
        <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">Delivery</h4>

        {/* Banner master toggle + live preview. */}
        <div class="flex flex-col gap-2 rounded border border-border bg-card/30 p-3">
          <ToggleRow
            label="Show notification banners"
            description="Pop an OS notification banner when an agent waits, finishes, or needs permission. Turn off for badge-only, silent delivery."
            checked={seeded() ? localBannerEnabled() : (config()?.notify_banner_enabled ?? true)}
            onChange={handleBannerToggle}
            disabled={saving()}
          />
          <div class="flex justify-center py-1">
            <NotificationBannerPreview
              enabled={seeded() ? localBannerEnabled() : (config()?.notify_banner_enabled ?? true)}
            />
          </div>
        </div>

        {/* Dock badge — macOS only. */}
        <Show when={isMacos()}>
          <div class="mt-1.5 flex flex-col gap-2 rounded border border-border bg-card/30 p-3">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <p class="text-xs text-foreground">Dock badge</p>
                <p class="text-[10px] text-muted-foreground">
                  Show a count on the raum dock icon. Independent of banners — leave this on for a
                  silent "glance" signal.
                </p>
              </div>
              <DockBadgePreview
                mode={seeded() ? localBadgeMode() : (config()?.badge_mode ?? "all_unread")}
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                as="button"
                type="button"
                disabled={saving()}
                class="flex flex-1 items-center justify-between gap-2 rounded border border-border bg-background px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent focus:border-ring focus:outline-none disabled:pointer-events-none disabled:opacity-50"
              >
                <span class="truncate">
                  {BADGE_MODE_OPTIONS.find((o) => o.value === localBadgeMode())?.label ??
                    "All unread"}
                </span>
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
                <DropdownMenuContent class="min-w-[var(--kb-popper-anchor-width)]">
                  <For each={BADGE_MODE_OPTIONS}>
                    {(opt) => (
                      <DropdownMenuItem
                        class="text-xs"
                        onSelect={() => void handleBadgeModeSelect(opt.value)}
                      >
                        <CheckIcon
                          class={cx(
                            "size-3",
                            localBadgeMode() === opt.value ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <span class="flex flex-col">
                          <span>{opt.label}</span>
                          <span class="text-[10px] text-muted-foreground">{opt.description}</span>
                        </span>
                      </DropdownMenuItem>
                    )}
                  </For>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenu>
          </div>
        </Show>
      </div>

      {/* When to notify — event filters. Only meaningful while banners
          are on; we gray them out (via `disabled`) when the master
          switch is off so the interaction hints at the dependency. */}
      <div class="flex flex-col gap-1.5">
        <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">When to notify</h4>
        <div class="flex flex-col gap-1">
          <ToggleRow
            label="Agent needs input"
            description="Banner when an agent is waiting for your reply."
            checked={seeded() ? localWaiting() : (config()?.notify_on_waiting ?? true)}
            onChange={handleWaitingToggle}
            disabled={saving() || !(seeded() ? localBannerEnabled() : true)}
          />
          <ToggleRow
            label="Agent finished"
            description="Banner when an agent completes or encounters an error."
            checked={seeded() ? localDone() : (config()?.notify_on_done ?? true)}
            onChange={handleDoneToggle}
            disabled={saving() || !(seeded() ? localBannerEnabled() : true)}
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
