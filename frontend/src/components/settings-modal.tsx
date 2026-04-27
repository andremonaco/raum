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
import {
  Component,
  For,
  Show,
  createEffect,
  createResource,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Dialog as DialogPrimitive } from "@kobalte/core/dialog";

import { cx } from "~/lib/cva";
import { tildify } from "~/lib/pathDisplay";
import {
  DEFAULT_THEME_ID,
  THEME_CATALOG,
  beginThemePreview,
  endThemePreview,
  getCurrentTheme,
  pickCustomThemeFile,
  previewThemeId,
  setCustomThemePath,
  setThemeId,
  subscribeThemeChange,
  type ThemeCatalogEntry,
} from "~/lib/theme/themeController";
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
} from "../lib/notificationCenter";
import {
  harnessHealth,
  harnessReport,
  installHarness,
  refreshHarnessReport,
  runHarnessSelftest,
  scanHarnessInstallState,
  type ConfigPathEntry,
  type HarnessStatus,
  type ScanReport,
} from "../stores/harnessStatusStore";
import { activeProjectSlug, projectStore } from "../stores/projectStore";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import {
  CheckIcon,
  HARNESS_ICONS,
  LoaderIcon,
  PlayIcon,
  RaumLogo,
  type HarnessIconKind,
} from "./icons";
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

type SectionId = "appearance" | "notifications" | "harnesses" | "worktrees" | "updates";

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
    id: "appearance",
    label: "Appearance",
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
        {/* Two overlapping rounded panes — reads as stacked app windows. */}
        <rect x="3" y="4" width="13" height="13" rx="2.5" />
        <rect x="8" y="7" width="13" height="13" rx="2.5" />
      </svg>
    ),
  },
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

function linuxNotificationServiceUnavailable(): boolean {
  return (
    notificationBundleId() === "org.freedesktop.Notifications" && permissionState() === "denied"
  );
}

function notificationReadinessLabel(): string {
  if (notificationDevMode()) return "Use bundled app";
  if (linuxNotificationServiceUnavailable()) return "Service unavailable";
  const state = permissionState();
  if (state === "granted") return "Working";
  if (state === "denied") return "OS permission denied";
  return "Permission not set";
}

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

/**
 * Curated VSCode theme picker. Drives `lib/theme/themeController` —
 * persistence + xterm/CodeMirror retheme — while keeping the picker UI
 * pattern identical to the Notifications "Sound" dropdown so the two
 * sibling Appearance pickers feel familiar.
 *
 * Custom themes (BYO) live behind a dedicated "Load custom .json…" item
 * that opens the Tauri dialog plugin, reads the file via `file_read`,
 * normalizes it through the same pipeline as catalog themes, and
 * persists the path to `AppearanceConfig.custom_theme_path` so it
 * survives across launches.
 */
const ThemePickerSection: Component = () => {
  const [selectedId, setSelectedId] = createSignal<string>(
    getCurrentTheme()?.id ?? DEFAULT_THEME_ID,
  );
  const [selectedLabel, setSelectedLabel] = createSignal<string>(
    getCurrentTheme()?.label ?? "raum Default Dark",
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [showAttribution, setShowAttribution] = createSignal(false);

  // The controller fires after every successful theme apply (boot,
  // catalog pick, or custom load). Mirror its state into local signals so
  // the trigger label and the active-row check stay in sync regardless of
  // who initiated the change.
  const unsubscribe = subscribeThemeChange((next) => {
    setSelectedId(next.id);
    setSelectedLabel(next.label);
    setError(null);
  });
  onCleanup(() => unsubscribe());

  const dark: ThemeCatalogEntry[] = THEME_CATALOG.filter((e) => e.type === "dark");
  const light: ThemeCatalogEntry[] = THEME_CATALOG.filter((e) => e.type === "light");

  const isCustom = () => selectedId().startsWith("custom:");

  const pickCurated = async (id: string): Promise<void> => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      // The theme may already be live via the hover preview; `setThemeId`
      // is still the right call — it overrides any preview session and
      // handles the persist. Broadcasting an already-current theme is a
      // cheap no-op in the subscribers.
      await setThemeId(id);
    } catch (e) {
      console.warn("setThemeId failed", e);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickCustom = async (): Promise<void> => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const path = await pickCustomThemeFile();
      if (!path) return;
      await setCustomThemePath(path);
    } catch (e) {
      console.warn("setCustomThemePath failed", e);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Fire a preview for the given theme id. Swallows errors so a broken
   * catalog entry doesn't tear down the picker.
   */
  const hoverPreview = (id: string): void => {
    void previewThemeId(id).catch((e) => console.warn("previewThemeId failed", e));
  };

  /**
   * Called when the dropdown opens/closes. On open we snapshot the current
   * theme (so we can restore it on dismiss); on close we restore unless
   * `pickCurated` already committed (in which case `setThemeId` cleared the
   * preview session and `endThemePreview` is a no-op).
   */
  const onDropdownOpenChange = (open: boolean): void => {
    if (open) {
      beginThemePreview();
    } else {
      endThemePreview(false);
    }
  };

  const triggerLabel = (): string => (isCustom() ? `Custom: ${selectedLabel()}` : selectedLabel());

  return (
    <div class="flex flex-col gap-1.5">
      <h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">Theme</h4>
      <div class="flex flex-col gap-2 rounded border border-border bg-card/30 px-3 py-3">
        <p class="text-[10px] text-muted-foreground">
          Built on the VSCode theme JSON format — the same shape used by Dracula, Tokyo Night,
          GitHub, Catppuccin, and friends. Switching retints chrome, terminals, and the file editor
          without remounting anything.
        </p>

        <div class="flex items-center gap-1.5">
          <DropdownMenu onOpenChange={onDropdownOpenChange}>
            <DropdownMenuTrigger
              as="button"
              type="button"
              disabled={busy()}
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
              <DropdownMenuContent class="max-h-[320px] min-w-[var(--kb-popper-anchor-width)] overflow-y-auto">
                <div class="px-2 py-1 text-[9px] uppercase tracking-wider text-muted-foreground/70">
                  Dark
                </div>
                <For each={dark}>
                  {(entry) => (
                    <DropdownMenuItem
                      class="text-xs"
                      onSelect={() => void pickCurated(entry.id)}
                      onMouseEnter={() => hoverPreview(entry.id)}
                      onFocus={() => hoverPreview(entry.id)}
                    >
                      <CheckIcon
                        class={cx(
                          "size-3",
                          selectedId() === entry.id ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span>{entry.label}</span>
                    </DropdownMenuItem>
                  )}
                </For>
                <DropdownMenuSeparator />
                <div class="px-2 py-1 text-[9px] uppercase tracking-wider text-muted-foreground/70">
                  Light
                </div>
                <For each={light}>
                  {(entry) => (
                    <DropdownMenuItem
                      class="text-xs"
                      onSelect={() => void pickCurated(entry.id)}
                      onMouseEnter={() => hoverPreview(entry.id)}
                      onFocus={() => hoverPreview(entry.id)}
                    >
                      <CheckIcon
                        class={cx(
                          "size-3",
                          selectedId() === entry.id ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span>{entry.label}</span>
                    </DropdownMenuItem>
                  )}
                </For>
                <DropdownMenuSeparator />
                <DropdownMenuItem class="text-xs" onSelect={() => void pickCustom()}>
                  <CheckIcon class={cx("size-3", isCustom() ? "opacity-100" : "opacity-0")} />
                  <span>Load custom .json…</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenu>
        </div>

        <Show when={error()}>
          <p class="text-[10px] text-destructive">{error()}</p>
        </Show>

        <button
          type="button"
          onClick={() => setShowAttribution((v) => !v)}
          class="flex items-center gap-1 self-start text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          <span>{showAttribution() ? "Hide" : "Show"} attributions</span>
        </button>
        <Show when={showAttribution()}>
          <div class="rounded border border-border/70 bg-background/40 px-2 py-1.5 text-[10px] leading-snug text-muted-foreground">
            <p class="mb-1">
              Curated themes are sourced from{" "}
              <code class="font-mono text-muted-foreground/90">tm-themes</code> (Shiki). Each theme
              retains its upstream license — see{" "}
              <code class="font-mono text-muted-foreground/90">
                frontend/src/themes/catalog/LICENSES/
              </code>{" "}
              for full attributions.
            </p>
            <ul class="grid grid-cols-2 gap-x-3 gap-y-0.5">
              <For each={THEME_CATALOG.filter((e) => e.sourceVersion !== "local")}>
                {(e) => (
                  <li class="truncate">
                    {e.label} <span class="text-muted-foreground/60">— MIT</span>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
      </div>
    </div>
  );
};

const AppearanceSection: Component = () => {
  return (
    <div class="flex flex-col gap-4">
      <ThemePickerSection />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Notifications section
// ---------------------------------------------------------------------------

interface NotifConfig {
  notify_on_waiting: boolean;
  notify_on_done: boolean;
  notify_banner_enabled: boolean;
  sound: string | null;
  badge_mode: BadgeMode;
}

interface NotifOsInfo {
  family: "macos" | "linux" | "other";
}

function isBadgeMode(value: unknown): value is BadgeMode {
  return value === "off" || value === "critical" || value === "all_unread";
}

const BADGE_MODE_OPTIONS: { value: BadgeMode; label: string; description: string }[] = [
  {
    value: "off",
    label: "Off",
    description: "Never show a dock or taskbar badge.",
  },
  {
    value: "critical",
    label: "Critical only",
    description: "Count only open permission requests.",
  },
  {
    value: "all_unread",
    label: "All unread",
    description: "Count every agent currently waiting, completed, or errored.",
  },
];

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
        <p class="mt-0.5 truncate text-[11px] font-semibold text-foreground">
          Interactive Question
        </p>
        <p class="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">
          Claude Code is asking for feedback.
        </p>
      </div>
      <Show when={!props.enabled}>
        <span class="pointer-events-none absolute inset-x-0 bottom-1 text-center text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
          Banners are off
        </span>
      </Show>
    </div>
  );
};

const NotificationsSection: Component<{ active: boolean; open: boolean }> = (props) => {
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
                class="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-success/15 text-success"
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
    <div class="mt-1 flex flex-col gap-1.5 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2">
      <p class="text-[10px] font-medium text-warning">Install this harness</p>
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
            class="self-start rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] text-warning transition-colors hover:bg-warning/20 disabled:pointer-events-none disabled:opacity-45"
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

  // Rescan the raum-hooks install state whenever this tab becomes
  // active or the active project changes, so each harness card's
  // Notifications sub-row shows fresh ready/not-ready state.
  const harnessesActiveProjectRoot = () => {
    const slug = activeProjectSlug();
    if (!slug) return null;
    return projectStore.items.find((p) => p.slug === slug)?.rootPath ?? null;
  };
  createEffect(
    on([() => props.active, activeProjectSlug], ([active]) => {
      if (active) {
        void scanHarnessInstallState(harnessesActiveProjectRoot());
      }
    }),
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
          Detected harnesses and the extra flags raum passes when launching them.
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

                {/* Per-harness notification install status. Shell has no
                    hook/event surface, so skip the row there. */}
                <Show when={entry.id !== "shell"}>
                  <HarnessNotificationStatus kind={entry.id} />
                </Show>
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
  const previewRoot = () => tildify(previewProject()?.rootPath) || "~/example-project";
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
        <div class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[10px] text-destructive">
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

/** How this binary was installed — reported by the Rust `updater_install_flavor`
 *  command. `deb` and `homebrew` must NOT try in-app install: apt owns the
 *  Linux `.deb` file, and Homebrew owns the macOS cask record (replacing the
 *  bundle out of band leaves `brew list` stale and breaks later
 *  `brew upgrade`/`uninstall`). For everything else
 *  `update.downloadAndInstall()` works. */
type InstallFlavor = "macos" | "homebrew" | "appimage" | "deb" | "unknown";

/** GitHub release page for a given raum version, used as the fallback
 *  "open in browser" target for `.deb` installs. Matches the repo owner +
 *  tag convention baked into `release.yml`. */
const releasePageUrl = (version: string) =>
  `https://github.com/andremonaco/raum/releases/tag/v${version}`;

/** Command surfaced for Homebrew-cask installs; copied to the clipboard so
 *  users can paste it into a terminal. The cask is published from the
 *  release workflow's `bump-homebrew` job. */
const BREW_UPGRADE_COMMAND = "brew upgrade --cask raum";

const UpdatesSection: Component = () => {
  const [currentVersion] = createResource<string>(async () => {
    try {
      return await getVersion();
    } catch {
      return "unknown";
    }
  });

  const [installFlavor] = createResource<InstallFlavor>(async () => {
    try {
      return (await invoke<InstallFlavor>("updater_install_flavor")) ?? "unknown";
    } catch {
      // A stale capability or a failed IPC means we don't know the flavor;
      // fall back to permissive behaviour (try the install) rather than
      // locking users out.
      return "unknown";
    }
  });

  /** True when this install can accept `downloadAndInstall()` — i.e. it's
   *  neither a distro-managed `.deb` nor a Homebrew cask install. For
   *  `deb` we surface a link to the release page; for `homebrew` we
   *  surface the `brew upgrade --cask raum` command so brew stays
   *  authoritative. */
  const canSelfUpdate = () => {
    const f = installFlavor();
    return f !== "deb" && f !== "homebrew";
  };

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

  const [relaunching, setRelaunching] = createSignal(false);
  const runRelaunch = async () => {
    setRelaunching(true);
    try {
      await relaunch();
    } catch (e) {
      // Plugin failure is rare but possible (e.g. capability not granted on
      // an older installed version). Surface it so the user isn't left
      // staring at an unresponsive button — they can still quit manually.
      console.warn("relaunch failed", e);
      setPhase({
        kind: "error",
        message: `Automatic relaunch failed (${
          e instanceof Error ? e.message : String(e)
        }). Quit raum manually and reopen to finish the update.`,
      });
      setRelaunching(false);
    }
  };

  /** `.deb` installs can't self-update — apt owns the binary. Open the
   *  GitHub release page for the detected version so the user can grab
   *  the new `.deb` manually (or update via their package manager). */
  const openReleasePage = async (version: string) => {
    try {
      await openUrl(releasePageUrl(version));
    } catch (e) {
      console.warn("openUrl release page failed", e);
    }
  };

  /** Transient "Copied" affordance for the Homebrew-flow button. Flips
   *  back to the default label after 2 s so the row stays quiet. */
  const [brewCopied, setBrewCopied] = createSignal(false);
  const copyBrewCommand = async () => {
    const ok = await copyToClipboard(BREW_UPGRADE_COMMAND);
    if (!ok) return;
    setBrewCopied(true);
    setTimeout(() => setBrewCopied(false), 2000);
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
            <p class="text-[10px] text-muted-foreground">The version of raum you're running.</p>
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
                  Every update is verified before it's installed, so you only get genuine releases.
                </p>
              </Show>
              <Show when={phase().kind === "up-to-date"}>
                <p class="text-xs text-success">raum is up to date.</p>
                <p class="text-[10px] text-muted-foreground">
                  You're running the latest published release.
                </p>
              </Show>
              <Show when={phase().kind === "available"}>
                {(() => {
                  const p = phase();
                  if (p.kind !== "available") return null;
                  const fallbackCopy = () => {
                    if (installFlavor() === "homebrew") {
                      return "You installed raum with Homebrew, so updates go through brew. Run the command below in your terminal to upgrade.";
                    }
                    return "raum was installed through your system's package manager, so in-app updates are off. Grab the latest build from the release page or update the way you usually do.";
                  };
                  return (
                    <>
                      <p class="text-xs text-foreground">
                        Update available:{" "}
                        <span class="font-mono text-warning">{p.update.version}</span>
                      </p>
                      <p class="text-[10px] text-muted-foreground">
                        {canSelfUpdate()
                          ? `Released ${
                              p.update.date ?? "recently"
                            }. Click "Install" to download and relaunch.`
                          : fallbackCopy()}
                      </p>
                      <Show when={!canSelfUpdate() && installFlavor() === "homebrew"}>
                        <div class="mt-2 flex items-center gap-2 rounded border border-border bg-background px-2 py-1">
                          <code class="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                            {BREW_UPGRADE_COMMAND}
                          </code>
                          <button
                            type="button"
                            class="shrink-0 rounded border border-border bg-card/30 px-2 py-0.5 text-[10px] text-foreground transition-colors hover:bg-accent"
                            onClick={() => void copyBrewCommand()}
                            title={brewCopied() ? "Copied to clipboard" : "Copy to clipboard"}
                          >
                            {brewCopied() ? "Copied" : "Copy"}
                          </button>
                        </div>
                      </Show>
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
                      <p class="text-xs text-success">Installed {p.version} — ready to relaunch.</p>
                      <p class="text-[10px] text-muted-foreground">
                        Your terminals and running agents will come back exactly where they left
                        off.
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
                      <p class="text-xs text-destructive">Update failed</p>
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
                {(() => {
                  const p = phase();
                  if (p.kind !== "available") return null;
                  if (canSelfUpdate()) {
                    return (
                      <button
                        type="button"
                        class="rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] text-warning transition-colors hover:bg-warning/20 disabled:pointer-events-none disabled:opacity-45"
                        onClick={() => void runInstall()}
                        disabled={isBusy()}
                      >
                        Install
                      </button>
                    );
                  }
                  return (
                    <button
                      type="button"
                      class="rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 text-[10px] text-warning transition-colors hover:bg-warning/20"
                      onClick={() => void openReleasePage(p.update.version)}
                    >
                      View release
                    </button>
                  );
                })()}
              </Show>
              <Show when={phase().kind === "installed"}>
                <button
                  type="button"
                  class="rounded-md border border-success/40 bg-success/10 px-2 py-0.5 text-[10px] text-success transition-colors hover:bg-success/20 disabled:pointer-events-none disabled:opacity-45"
                  onClick={() => void runRelaunch()}
                  disabled={relaunching()}
                >
                  {relaunching() ? "Relaunching…" : "Relaunch now"}
                </button>
              </Show>
              <button
                type="button"
                class="rounded border border-border bg-background px-2 py-0.5 text-[10px] text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                onClick={() => void runCheck()}
                disabled={isBusy() || relaunching()}
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
            description="Quietly checks for new versions a few seconds after raum opens."
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
 * Small "open-in-Finder" button next to a path. Uses the Tauri opener
 * plugin's `revealItemInDir`, which opens Finder/Explorer/Nautilus and
 * highlights the file (no need to compute the parent directory
 * ourselves). Keyboard-accessible via the native `<button>` focus
 * ring.
 */
const RevealPathRow: Component<{ entry: ConfigPathEntry }> = (props) => {
  const reveal = async () => {
    try {
      await revealItemInDir(props.entry.path);
    } catch (e) {
      console.warn("revealItemInDir failed", e);
    }
  };
  const statusTone = () => {
    if (!props.entry.exists) return "text-muted-foreground";
    return props.entry.raumManaged ? "text-success" : "text-warning";
  };
  const statusLabel = () => {
    if (!props.entry.exists) return "not created";
    return props.entry.raumManaged ? "managed" : "needs setup";
  };
  return (
    <div class="flex items-center gap-2 text-[10px]">
      <span class="shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground/60">
        {props.entry.label}
      </span>
      <button
        type="button"
        class="focus-ring group inline-flex min-w-0 flex-1 items-center gap-1.5 rounded border border-transparent bg-background/40 px-1.5 py-0.5 text-left text-muted-foreground transition-colors hover:border-border hover:text-foreground"
        onClick={() => void reveal()}
        title={`Reveal in file manager — ${tildify(props.entry.path)}`}
        aria-label={`Reveal ${props.entry.label} in file manager`}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="size-3 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
        </svg>
        <span class="min-w-0 truncate font-mono">{tildify(props.entry.path)}</span>
      </button>
      <span class={cx("shrink-0 text-[9px]", statusTone())}>{statusLabel()}</span>
    </div>
  );
};

const pathsReady = (scan: ScanReport | null): boolean => {
  if (!scan) return false;
  return scan.raumHooksInstalled;
};

/**
 * Per-harness notification setup row (Phase 7b rewrite).
 *
 * Rendered once per harness inside `HarnessesSection`, so the user
 * sees install state inline with the rest of the harness settings
 * (their mental model is "configure Claude Code under Claude Code").
 *
 * Reads from `harnessStatusStore` via `harnessHealth()`; the scan is
 * triggered by the parent section when it becomes active.
 *
 *  * Ready-state pill combining `raumHooksInstalled` AND OS
 *    notification permission (the "notifications ready" rule — both
 *    the transport and the consumer have to work).
 *  * Clickable managed-config paths (reveal in Finder/Explorer).
 *  * On-demand Install button that runs the setup plan + selftest.
 *  * Warning row when OS notifications are granted but the harness
 *    isn't wired yet.
 */
const HarnessNotificationStatus: Component<{ kind: HarnessIconKind }> = (props) => {
  const activeSlug = () => activeProjectSlug();
  const activeProjectRoot = () => {
    const slug = activeSlug();
    if (!slug) return null;
    return projectStore.items.find((p) => p.slug === slug)?.rootPath ?? null;
  };
  const [installing, setInstalling] = createSignal(false);

  const osNotificationsGranted = () => permissionState() === "granted";

  const entry = () => harnessHealth()[props.kind] ?? null;
  const scan = () => entry()?.scan ?? null;
  const installed = () => scan()?.raumHooksInstalled ?? false;
  const canInstall = () => !!scan() && (scan()?.binaryOnPath ?? false);
  const ready = () => pathsReady(scan()) && osNotificationsGranted();
  const disabledReason = () => {
    const s = scan();
    if (!s) return null;
    if (!s.binaryOnPath) return `Install ${s.binary} first`;
    return null;
  };

  const onInstall = async () => {
    setInstalling(true);
    try {
      const ok = await installHarness({
        harness: props.kind,
        projectSlug: activeSlug() ?? null,
        worktreeId: null,
      });
      if (ok) {
        // Setup + selftest events were emitted by the backend;
        // additionally rescan paths so the Ready pill flips
        // immediately.
        await scanHarnessInstallState(activeProjectRoot());
      }
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div class="flex flex-col gap-1.5 border-t border-border/50 px-3 py-2">
      <div class="flex items-center gap-2">
        <span class="text-[9px] uppercase tracking-wider text-muted-foreground/60">
          Notifications
        </span>
        <span class="ml-auto">
          <Show when={scan()} fallback={<StatusPill tone="muted">Scanning…</StatusPill>}>
            <Show
              when={ready()}
              fallback={
                <StatusPill tone={installed() ? "warn" : "error"}>
                  {installed() ? "Notifications not ready" : "Notifications not ready"}
                </StatusPill>
              }
            >
              <StatusPill tone="ok">Notifications ready</StatusPill>
            </Show>
          </Show>
        </span>
      </div>

      {/* Reason / note line */}
      <Show when={scan()?.note}>
        {(note) => <p class="text-[10px] text-muted-foreground">{note()}</p>}
      </Show>

      {/* Managed config paths (clickable to reveal) */}
      <Show when={(scan()?.configPaths.length ?? 0) > 0}>
        <div class="flex flex-col gap-0.5">
          <For each={scan()!.configPaths}>{(p) => <RevealPathRow entry={p} />}</For>
        </div>
      </Show>

      {/* Smart warning: OS permission granted but harness not wired. */}
      <Show when={scan() && !installed() && osNotificationsGranted() && canInstall()}>
        <div class="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[10px] text-warning">
          OS notifications are enabled but {props.kind} isn't configured to send them. Click Install
          to fix.
        </div>
      </Show>

      {/* Binary missing row */}
      <Show when={scan() && !scan()!.binaryOnPath}>
        <div class="rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-[10px] text-destructive">
          {scan()?.binary} isn't installed yet. Install it to enable notifications.
        </div>
      </Show>

      {/* Setup report — surfaces per-action failures so the user knows
          which file couldn't be written. */}
      <Show when={entry()?.setup && entry()!.setup!.length > 0 && entry()?.setupOk === false}>
        <ul class="ml-5 list-disc text-[10px] text-muted-foreground">
          <For each={entry()!.setup!}>
            {(a) => (
              <Show when={a.outcome === "failed"}>
                <li>
                  <span class="text-destructive">{a.outcome}</span>{" "}
                  <span class="text-foreground-subtle">{a.actionKind}</span>
                  <Show when={a.detail}>
                    {(d) => <span class="text-foreground-dim"> — {d()}</span>}
                  </Show>
                </li>
              </Show>
            )}
          </For>
        </ul>
      </Show>

      {/* Selftest report */}
      <Show when={entry()?.selftest}>
        {(st) => (
          <div class="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span class={st().ok ? "text-success" : "text-destructive"}>
              Test {st().ok ? "passed" : "failed"}
            </span>
            <Show when={!st().ok && st().detail}>
              <span class="text-foreground-dim">— {st().detail}</span>
            </Show>
          </div>
        )}
      </Show>

      {/* Install / Reinstall + Selftest row */}
      <div class="flex flex-wrap items-center gap-1.5">
        <Show when={(scan()?.configPaths.length ?? 0) > 0 || !installed()}>
          <button
            type="button"
            class="focus-ring rounded-md border border-border bg-background px-2 py-0.5 text-[10px] text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
            onClick={() => void onInstall()}
            disabled={installing() || !canInstall() || !scan()}
            title={disabledReason() ?? undefined}
          >
            {installing() ? "Installing…" : installed() ? "Reinstall" : "Install"}
          </button>
        </Show>
        <button
          type="button"
          class="focus-ring rounded-md border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-hover hover:text-foreground"
          onClick={() => {
            void runHarnessSelftest(props.kind, {
              projectSlug: activeSlug() ?? null,
              worktreeId: null,
            });
          }}
        >
          Test
        </button>
      </div>
    </div>
  );
};

const SectionContent: Component<{ section: SectionId; open: boolean }> = (props) => {
  return (
    <>
      <div class={cx(props.section === "appearance" ? "" : "hidden")}>
        <AppearanceSection />
      </div>
      <div class={cx(props.section === "notifications" ? "" : "hidden")}>
        <NotificationsSection active={props.section === "notifications"} open={props.open} />
      </div>
      <div class={cx(props.section === "harnesses" ? "" : "hidden")}>
        <HarnessesSection active={props.section === "harnesses"} />
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
  const [activeSection, setActiveSection] = createSignal<SectionId>("appearance");

  return (
    <DialogPrimitive open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogPrimitive.Portal>
        {/* Overlay */}
        <DialogPrimitive.Overlay class="data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 fixed inset-0 z-50 bg-scrim-strong" />

        {/* Modal shell */}
        <DialogPrimitive.Content class="floating-surface data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95 fixed top-[50%] left-[50%] z-50 flex h-[min(780px,calc(100vh-2rem))] max-h-[780px] w-[min(1000px,calc(100vw-2rem))] max-w-[1000px] translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-xl border border-border-subtle bg-popover duration-200 focus:outline-none">
          {/* Title row (visually hidden, for accessibility) */}
          <DialogPrimitive.Title class="sr-only">Settings</DialogPrimitive.Title>

          {/* Body: left sidebar + right content */}
          <div class="flex min-h-0 flex-1 overflow-hidden">
            {/* Left nav sidebar */}
            <div class="flex w-40 shrink-0 flex-col border-r border-border-subtle bg-panel">
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
                        "flex w-full items-center gap-2 rounded px-1.5 py-1 text-[11px] transition-colors focus:outline-none focus-visible:outline-none",
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
                <SectionContent section={activeSection()} open={props.open} />
              </Scrollable>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive>
  );
};
