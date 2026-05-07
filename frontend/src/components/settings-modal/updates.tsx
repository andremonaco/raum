import { Component, Show, createEffect, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";

import { ToggleRow } from "./shared";
import { BREW_UPGRADE_COMMAND, releasePageUrl } from "./constants";
import type { InstallFlavor, UpdatePhase } from "./types";
import { copyToClipboard } from "./utils";

export const UpdatesSection: Component = () => {
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
