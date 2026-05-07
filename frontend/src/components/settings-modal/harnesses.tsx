import { Component, For, Show, createEffect, createResource, createSignal, on } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import { cx } from "~/lib/cva";
import { tildify } from "~/lib/pathDisplay";
import { permissionState } from "../../lib/notificationCenter";
import {
  harnessHealth,
  harnessReport,
  installHarness,
  refreshHarnessReport,
  runHarnessSelftest,
  scanHarnessInstallState,
  type ConfigPathEntry,
  type HarnessStatus,
} from "../../stores/harnessStatusStore";
import { activeProjectSlug, projectStore } from "../../stores/projectStore";

import { CheckIcon, HARNESS_ICONS, LoaderIcon, type HarnessIconKind } from "../icons";

import { StatusPill } from "./shared";
import { HARNESS_ENTRIES, INSTALL_COMMANDS } from "./constants";
import { copyToClipboard, pathsReady } from "./utils";

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

export const HarnessesSection: Component<{ active: boolean }> = (props) => {
  const [config, { mutate: mutateConfig }] = createResource(async () => {
    const cfg = await invoke<{
      harnesses?: {
        shell?: { extra_flags?: string | null };
        "claude-code"?: { extra_flags?: string | null; fullscreen?: boolean };
        codex?: { extra_flags?: string | null };
        opencode?: { extra_flags?: string | null };
      };
    }>("config_get");
    return cfg.harnesses ?? {};
  });

  // Reactive read of the persisted Claude Code fullscreen flag. Defaults
  // to `true` so we match the backend default before the resource resolves.
  const claudeFullscreen = () => config()?.["claude-code"]?.fullscreen ?? true;
  const [savingFullscreen, setSavingFullscreen] = createSignal(false);
  const handleClaudeFullscreenToggle = async (enabled: boolean) => {
    setSavingFullscreen(true);
    try {
      await invoke("config_set_claude_fullscreen", { enabled });
      // Optimistic local update so the toggle reflects immediately;
      // `config_get` will be refetched on the next section mount.
      mutateConfig((prev) => ({
        ...(prev ?? {}),
        "claude-code": {
          ...(prev?.["claude-code"] ?? {}),
          fullscreen: enabled,
        },
      }));
    } catch (e) {
      console.warn("config_set_claude_fullscreen failed", e);
    } finally {
      setSavingFullscreen(false);
    }
  };

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

                {/* Claude-only: fullscreen-mode toggle. Defaulting to
                    fullscreen avoids Ink's hard-wrap-into-scrollback
                    corruption on resize/restart by routing Claude into
                    its alt-screen TUI via CLAUDE_CODE_NO_FLICKER=1.
                    Disabling reverts to legacy inline scrollback, where
                    raum falls back to disk-backed snapshot replay on
                    reattach. */}
                <Show when={entry.id === "claude-code"}>
                  <div class="border-t border-border/50 px-3 py-2">
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0 flex-1">
                        <p class="text-[10px] font-medium text-foreground">Fullscreen rendering</p>
                        <p class="text-[10px] text-muted-foreground">
                          Claude paints the alt-screen instead of inline. Recommended — eliminates
                          resize and restart corruption from Ink's hard-wrapped output.
                        </p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={claudeFullscreen()}
                        disabled={savingFullscreen() || config.loading}
                        class={cx(
                          "relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-border transition-colors",
                          "disabled:cursor-not-allowed disabled:opacity-50",
                          claudeFullscreen() ? "bg-success/40" : "bg-muted/40",
                        )}
                        onClick={() => void handleClaudeFullscreenToggle(!claudeFullscreen())}
                      >
                        <span
                          class={cx(
                            "inline-block h-3 w-3 transform rounded-full bg-foreground transition-transform",
                            claudeFullscreen() ? "translate-x-3" : "translate-x-0.5",
                          )}
                        />
                      </button>
                    </div>
                  </div>
                </Show>

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
