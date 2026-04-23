/**
 * §13.1–13.2 — 4-step onboarding wizard (intro + 3 workflow steps).
 *
 * Step 0: Welcome — introduces raum with an animated app-shell mock and a
 *         short bulleted pitch. No backend calls; Next advances to step 1,
 *         Skip marks onboarding complete. Body lives in
 *         `./onboarding-intro-step.tsx` so this file doesn't bloat.
 * Step 1: Prerequisites — combined `prereqs_check` (tmux, git) and
 *         `harnesses_check` (claude-code, codex, opencode) probe. tmux and
 *         git must both report `found && meets_minimum` before "Next" is
 *         enabled; harnesses are informational (users can still advance
 *         without any installed). A single "Re-check" button re-runs both
 *         probes.
 * Step 2: First project — directory picker via `tauri-plugin-dialog::open`
 *         plus a name input; on "Next" invokes `project_register` and
 *         upserts the returned `ProjectListItem` into `projectStore`.
 * Step 3: First pane — "Spawn" dispatches a `raum:spawn-requested` window
 *         event (the same one the top bar uses), which `TerminalGrid`
 *         turns into a pane; the pane's own `TerminalPane` then calls
 *         `terminal_spawn`. The wizard closes itself right after so the
 *         user lands on the main UI with the new pane visible.
 *
 * Skip: every step has a "Skip" button that immediately marks onboarding
 *       complete (via `config_mark_onboarded`) and unmounts the wizard.
 *
 * The `onDone` callback is invoked after a successful finish *or* skip; the
 * parent (`App.tsx`) uses it to drop its `showWizard` signal.
 */

import { Component, For, Match, Show, Switch, createResource, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { upsertProject, type ProjectListItem } from "../stores/projectStore";
import { tildify } from "../lib/pathDisplay";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogPortal } from "./ui/dialog";
import { TextField, TextFieldInput, TextFieldLabel } from "./ui/text-field";
import { FolderIcon, HARNESS_ICONS } from "./icons";
import { RaumLogo } from "./icons/raum-logo";
import { OnboardingIntroStep } from "./onboarding-intro-step";

export interface OnboardingWizardProps {
  onDone: () => void;
}

type Harness = "claude-code" | "codex" | "opencode";

interface HarnessStatus {
  kind: Harness;
  binary: string;
  found: boolean;
  version: string | null;
  raw: string | null;
}
interface HarnessReport {
  harnesses: HarnessStatus[];
}

interface HarnessMeta {
  label: string;
  hint: string;
  install: InstallHint[];
}

const HARNESS_META: Record<Harness, HarnessMeta> = {
  "claude-code": {
    label: "Claude Code",
    hint: "Anthropic's Claude Code CLI.",
    install: [
      {
        pkgManager: "npm",
        command: "npm install -g @anthropic-ai/claude-code",
      },
      {
        pkgManager: "Docs",
        command: "https://docs.claude.com/en/docs/claude-code",
      },
    ],
  },
  codex: {
    label: "Codex",
    hint: "OpenAI Codex CLI.",
    install: [
      { pkgManager: "npm", command: "npm install -g @openai/codex" },
      { pkgManager: "Docs", command: "https://github.com/openai/codex" },
    ],
  },
  opencode: {
    label: "OpenCode",
    hint: "OpenCode community CLI.",
    install: [
      { pkgManager: "npm", command: "npm install -g opencode-ai" },
      { pkgManager: "Docs", command: "https://opencode.ai" },
    ],
  },
};

interface ToolStatus {
  name: string;
  found: boolean;
  version: string | null;
  meets_minimum: boolean;
  minimum: string;
  raw: string | null;
}
interface PrereqReport {
  tmux: ToolStatus;
  git: ToolStatus;
}

interface OsInfo {
  family: "macos" | "linux" | "other";
  linuxId: string | null;
  linuxIdLike: string[];
}

type ToolName = "tmux" | "git";

interface InstallHint {
  pkgManager: string;
  command: string;
}

function installHintsFor(tool: ToolName, os: OsInfo | undefined): InstallHint[] {
  if (!os) return [];
  if (os.family === "macos") {
    return [
      {
        pkgManager: "Homebrew",
        command: `brew install ${tool} || brew upgrade ${tool}`,
      },
      {
        pkgManager: "MacPorts",
        command: `sudo port install ${tool} || sudo port upgrade ${tool}`,
      },
    ];
  }
  if (os.family === "linux") {
    const ids = [...(os.linuxId ? [os.linuxId] : []), ...os.linuxIdLike].map((s) =>
      s.toLowerCase(),
    );
    const matches = (...keys: string[]) => keys.some((k) => ids.includes(k));
    if (matches("ubuntu", "debian", "pop", "linuxmint")) {
      return [
        {
          pkgManager: "apt (Ubuntu/Debian)",
          command: `sudo apt update && sudo apt install --only-upgrade -y ${tool} || sudo apt install -y ${tool}`,
        },
      ];
    }
    if (matches("fedora", "rhel", "centos", "rocky", "almalinux")) {
      return [
        {
          pkgManager: "dnf (Fedora/RHEL)",
          command: `sudo dnf install -y ${tool}`,
        },
      ];
    }
    if (matches("arch", "manjaro", "endeavouros")) {
      return [
        {
          pkgManager: "pacman (Arch)",
          command: `sudo pacman -S --needed ${tool}`,
        },
      ];
    }
    if (matches("opensuse", "opensuse-tumbleweed", "opensuse-leap", "suse")) {
      return [
        {
          pkgManager: "zypper (openSUSE)",
          command: `sudo zypper install -y ${tool}`,
        },
      ];
    }
    if (matches("alpine")) {
      return [
        {
          pkgManager: "apk (Alpine)",
          command: `sudo apk add ${tool}`,
        },
      ];
    }
    return [
      {
        pkgManager: "apt (Debian-family)",
        command: `sudo apt install -y ${tool}`,
      },
      {
        pkgManager: "dnf (RHEL-family)",
        command: `sudo dnf install -y ${tool}`,
      },
      {
        pkgManager: "pacman (Arch)",
        command: `sudo pacman -S --needed ${tool}`,
      },
    ];
  }
  return [];
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through.
  }
  return false;
}

function StatusDot(props: { ok: boolean }) {
  return (
    <span
      class="inline-block h-2 w-2 rounded-full"
      classList={{
        "bg-success": props.ok,
        "bg-destructive": !props.ok,
      }}
      aria-hidden="true"
    />
  );
}

function ToolRow(props: { tool: ToolStatus; os: OsInfo | undefined }) {
  const ok = () => props.tool.found && props.tool.meets_minimum;
  const hints = (): InstallHint[] => {
    if (ok()) return [];
    return installHintsFor(props.tool.name as ToolName, props.os);
  };
  const reason = (): "missing" | "outdated" | null => {
    if (ok()) return null;
    if (!props.tool.found) return "missing";
    return "outdated";
  };
  return (
    <li class="rounded-md border border-border bg-card/60 px-3 py-2 text-xs">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <StatusDot ok={ok()} />
          <span class="font-mono text-foreground">{props.tool.name}</span>
          <span class="text-muted-foreground">≥ {props.tool.minimum}</span>
        </div>
        <div class="text-right text-muted-foreground">
          <Show
            when={props.tool.found}
            fallback={
              <Badge variant="destructive" class="text-[10px]">
                not found on PATH
              </Badge>
            }
          >
            <span>
              found <span class="text-foreground">{props.tool.version ?? "?"}</span>
            </span>
            <Show when={!props.tool.meets_minimum}>
              <Badge variant="outline" class="ml-1 text-[10px]">
                below minimum
              </Badge>
            </Show>
          </Show>
        </div>
      </div>

      <Show when={reason() !== null}>
        <div class="mt-2 border-t border-border pt-2">
          <p class="mb-2 text-[11px] text-muted-foreground">
            <Show
              when={reason() === "missing"}
              fallback={<>Upgrade {props.tool.name} with one of:</>}
            >
              <>Install {props.tool.name} with one of:</>
            </Show>
          </p>
          <Show when={props.os?.family === "macos"}>
            <p class="mb-2 text-[11px] text-muted-foreground/80">
              Homebrew is the quickest way — the same package manager you likely used to install
              raum.
            </p>
          </Show>
          <Show
            when={hints().length > 0}
            fallback={
              <p class="text-[11px] text-muted-foreground/70">
                No suggestion for this OS — see your package manager docs.
              </p>
            }
          >
            <ul class="space-y-1.5">
              <For each={hints()}>{(hint) => <InstallCommand hint={hint} />}</For>
            </ul>
          </Show>
        </div>
      </Show>
    </li>
  );
}

function HarnessRow(props: { status: HarnessStatus }) {
  const meta = () => HARNESS_META[props.status.kind];
  const Icon = () => HARNESS_ICONS[props.status.kind];
  return (
    <li class="rounded-md border border-border bg-card/60 px-3 py-2 text-xs">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <StatusDot ok={props.status.found} />
          {(() => {
            const I = Icon();
            return <I class="size-3.5 text-foreground" />;
          })()}
          <span class="text-foreground">{meta().label}</span>
          <span class="font-mono text-[10px] text-muted-foreground">{props.status.binary}</span>
        </div>
        <div class="text-right text-muted-foreground">
          <Show
            when={props.status.found}
            fallback={
              <Badge variant="destructive" class="text-[10px]">
                not found on PATH
              </Badge>
            }
          >
            <span>
              found <span class="text-foreground">{props.status.version ?? "?"}</span>
            </span>
          </Show>
        </div>
      </div>

      <Show when={!props.status.found}>
        <div class="mt-2 border-t border-border pt-2">
          <p class="mb-2 text-[11px] text-muted-foreground">Install {meta().label} with:</p>
          <ul class="space-y-1.5">
            <For each={meta().install}>{(hint) => <InstallCommand hint={hint} />}</For>
          </ul>
        </div>
      </Show>
    </li>
  );
}

function HarnessCard(props: {
  status: HarnessStatus;
  spawning: boolean;
  error: string | undefined;
  onSpawn: () => void;
}) {
  const meta = () => HARNESS_META[props.status.kind];
  const Icon = HARNESS_ICONS[props.status.kind];
  return (
    <div
      class="flex flex-col gap-2 rounded-md border border-border bg-card/40 p-3"
      data-testid={`onboarding-harness-card-${props.status.kind}`}
    >
      <div class="flex items-start gap-2">
        <Icon class="mt-0.5 size-4 shrink-0 text-foreground" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-xs text-foreground">{meta().label}</div>
          <div class="truncate font-mono text-[10px] text-muted-foreground">
            {props.status.binary}
            <Show when={props.status.version}>
              {" "}
              <span class="text-foreground/70">{props.status.version}</span>
            </Show>
          </div>
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        class="h-7 text-[11px]"
        onClick={() => props.onSpawn()}
        disabled={props.spawning}
      >
        {props.spawning ? "Spawning…" : "Spawn"}
      </Button>
      <Show when={props.error}>
        <Alert variant="destructive" class="px-2 py-1 text-[10px]">
          <AlertDescription>{props.error}</AlertDescription>
        </Alert>
      </Show>
    </div>
  );
}

function InstallCommand(props: { hint: InstallHint }) {
  const [copied, setCopied] = createSignal(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  async function onCopy() {
    const ok = await copyToClipboard(props.hint.command);
    if (ok) {
      setCopied(true);
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => setCopied(false), 1500);
    }
  }
  return (
    <li>
      <div class="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {props.hint.pkgManager}
      </div>
      <div class="flex items-center gap-2 rounded-md bg-background px-2 py-1.5 font-mono">
        <code class="flex-1 break-all text-foreground">{props.hint.command}</code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          class="h-6 shrink-0 px-2 text-[10px] uppercase tracking-wide"
          onClick={() => void onCopy()}
        >
          {copied() ? "✓ copied" : "copy"}
        </Button>
      </div>
    </li>
  );
}

export const OnboardingWizard: Component<OnboardingWizardProps> = (props) => {
  const [step, setStep] = createSignal<0 | 1 | 2 | 3>(0);
  const [finishing, setFinishing] = createSignal(false);

  const [prereq, { refetch: refetchPrereqs }] = createResource<PrereqReport>(() =>
    invoke<PrereqReport>("prereqs_check").catch(() => ({
      tmux: {
        name: "tmux",
        found: false,
        version: null,
        meets_minimum: false,
        minimum: "3.2.0",
        raw: null,
      },
      git: {
        name: "git",
        found: false,
        version: null,
        meets_minimum: false,
        minimum: "2.30.0",
        raw: null,
      },
    })),
  );
  const prereqsOk = (): boolean => {
    const r = prereq();
    if (!r) return false;
    return r.tmux.found && r.tmux.meets_minimum && r.git.found && r.git.meets_minimum;
  };

  const [osInfo] = createResource<OsInfo>(() =>
    invoke<OsInfo>("os_info").catch(() => ({
      family: "other" as const,
      linuxId: null,
      linuxIdLike: [],
    })),
  );

  const [projectPath, setProjectPath] = createSignal("");
  const [projectName, setProjectName] = createSignal("");
  const [projectError, setProjectError] = createSignal<string | undefined>();
  const [projectBusy, setProjectBusy] = createSignal(false);
  const [registered, setRegistered] = createSignal<ProjectListItem | undefined>();

  function baseFolder(rootPath: string): string {
    if (!rootPath) return "";
    const normalized = rootPath.replace(/\\+/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  }
  function prettyName(rootPath: string): string {
    return baseFolder(rootPath);
  }

  async function pickDirectory() {
    setProjectError(undefined);
    try {
      const selection = await openDialog({
        directory: true,
        multiple: false,
        title: "Select project root",
      });
      const picked = typeof selection === "string" ? selection : null;
      if (picked) {
        setProjectPath(picked);
        if (!projectName().trim()) setProjectName(prettyName(picked));
      }
    } catch (e) {
      setProjectError(e instanceof Error ? e.message : String(e));
    }
  }

  async function registerProject() {
    if (!projectPath()) return;
    setProjectBusy(true);
    setProjectError(undefined);
    try {
      const item = await invoke<ProjectListItem>("project_register", {
        rootPath: projectPath(),
        name: projectName().trim() || prettyName(projectPath()),
      });
      upsertProject(item);
      setRegistered(item);
    } catch (e) {
      setProjectError(e instanceof Error ? e.message : String(e));
    } finally {
      setProjectBusy(false);
    }
  }

  const [harnessReport, { refetch: refetchHarnesses }] = createResource<HarnessReport>(() =>
    invoke<HarnessReport>("harnesses_check").catch(() => ({
      harnesses: (Object.keys(HARNESS_META) as Harness[]).map((kind) => ({
        kind,
        binary: kind === "claude-code" ? "claude" : kind,
        found: false,
        version: null,
        raw: null,
      })),
    })),
  );
  const prereqsLoading = (): boolean => prereq.loading || harnessReport.loading;

  const [prereqsJustChecked, setPrereqsJustChecked] = createSignal(false);
  let prereqsCheckedTimer: ReturnType<typeof setTimeout> | undefined;
  async function recheckAll() {
    setPrereqsJustChecked(false);
    await Promise.all([refetchPrereqs(), refetchHarnesses()]);
    setPrereqsJustChecked(true);
    if (prereqsCheckedTimer) clearTimeout(prereqsCheckedTimer);
    prereqsCheckedTimer = setTimeout(() => setPrereqsJustChecked(false), 2000);
  }

  const [spawningKinds, setSpawningKinds] = createSignal<Set<Harness>>(new Set());
  const [spawnErrors, setSpawnErrors] = createSignal<Partial<Record<Harness, string>>>({});
  const availableHarnesses = (): HarnessStatus[] =>
    (harnessReport()?.harnesses ?? []).filter((h) => h.found && h.kind !== ("shell" as Harness));

  async function spawnHarness(kind: Harness) {
    const rp = registered();
    if (!rp) {
      setSpawnErrors((prev) => ({
        ...prev,
        [kind]: "Add a project first, then launch a harness.",
      }));
      return;
    }
    setSpawningKinds((prev) => new Set(prev).add(kind));
    setSpawnErrors((prev) => {
      const next = { ...prev };
      delete next[kind];
      return next;
    });
    // Delegate pane creation + terminal_spawn to TerminalGrid — same event
    // the top bar dispatches. TerminalPane mounts against the new pane and
    // calls terminal_spawn itself; the resulting session id is tracked by
    // the layout store, not the wizard.
    window.dispatchEvent(
      new CustomEvent("raum:spawn-requested", {
        detail: { kind, projectSlug: rp.slug, worktreeId: undefined },
      }),
    );
    await markOnboarded();
  }

  async function markOnboarded() {
    setFinishing(true);
    try {
      await invoke("config_mark_onboarded");
    } catch {
      // Best-effort.
    } finally {
      setFinishing(false);
      props.onDone();
    }
  }

  async function next() {
    const s = step();
    if (s === 2 && registered() === undefined) {
      await registerProject();
      if (registered() === undefined) return;
    }
    if (s < 3) setStep((s + 1) as 0 | 1 | 2 | 3);
    else await markOnboarded();
  }
  function back() {
    const s = step();
    if (s > 0) setStep((s - 1) as 0 | 1 | 2 | 3);
  }

  const canAdvance = (): boolean => {
    switch (step()) {
      case 0:
        return true;
      case 1:
        return prereqsOk();
      case 2:
        return !projectBusy() && projectPath().length > 0;
      case 3:
        return true;
      default:
        return false;
    }
  };

  return (
    <Dialog open={true} modal>
      <DialogPortal>
        <DialogContent
          showCloseButton={false}
          class="flex h-[min(840px,calc(100vh-2rem))] max-h-[840px] w-[min(1000px,calc(100vw-2rem))] max-w-[1000px] flex-col gap-0 p-0 sm:max-w-[1000px]"
          data-testid="onboarding-wizard"
        >
          <header class="flex items-center justify-between border-b border-border px-8 py-5">
            <div class="flex items-center gap-2">
              <RaumLogo class="size-5 shrink-0" />
              <h2 class="text-xs font-medium" style={{ color: "var(--project-accent)" }}>
                Welcome to raum
              </h2>
            </div>
            <Show when={step() > 0}>
              <div
                class="flex items-center gap-1 text-[10px] text-muted-foreground"
                aria-label="Progress"
              >
                <For each={[1, 2, 3] as const}>
                  {(n) => (
                    <span
                      class="h-1.5 w-8 rounded"
                      classList={{
                        "bg-foreground": step() >= n,
                        "bg-muted": step() < n,
                      }}
                    />
                  )}
                </For>
              </div>
            </Show>
          </header>

          <div class="flex-1 overflow-y-auto px-8 py-7">
            <Switch>
              <Match when={step() === 0}>
                <OnboardingIntroStep />
              </Match>
              <Match when={step() === 1}>
                <div>
                  <h3 class="mb-1 text-xs font-medium">1. Prerequisites</h3>
                  <p class="mb-3 text-xs text-muted-foreground">
                    raum runs each terminal inside a tmux session so your agents keep running even
                    if the app restarts. You'll need tmux and git to continue — any harnesses we
                    find will be ready to spawn from the top bar.
                  </p>

                  <div class="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                    Required
                  </div>
                  <Show
                    when={prereq()}
                    fallback={<div class="text-xs text-muted-foreground">Probing…</div>}
                  >
                    {(report) => (
                      <ul class="space-y-2" data-testid="onboarding-prereqs">
                        <ToolRow tool={report().tmux} os={osInfo()} />
                        <ToolRow tool={report().git} os={osInfo()} />
                      </ul>
                    )}
                  </Show>

                  <div class="mt-4 mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                    Harnesses (optional)
                  </div>
                  <Show
                    when={harnessReport()}
                    fallback={
                      <div
                        class="flex items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground"
                        data-testid="onboarding-harness-checking"
                      >
                        <span
                          class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-foreground"
                          aria-hidden="true"
                        />
                        Probing harnesses…
                      </div>
                    }
                  >
                    {(report) => (
                      <ul
                        class="space-y-1"
                        aria-label="Harness availability"
                        data-testid="onboarding-harness"
                      >
                        <For
                          each={report().harnesses.filter((h) => h.kind !== ("shell" as Harness))}
                        >
                          {(status) => <HarnessRow status={status} />}
                        </For>
                      </ul>
                    )}
                  </Show>

                  <div class="mt-3 flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void recheckAll()}
                      disabled={prereqsLoading()}
                    >
                      <Show when={prereqsLoading()} fallback={<>Re-check</>}>
                        <span
                          class="mr-1.5 inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-foreground"
                          aria-hidden="true"
                        />
                        Checking…
                      </Show>
                    </Button>
                    <Show when={prereqsJustChecked() && !prereqsLoading()}>
                      <span class="text-[11px] text-muted-foreground">Checked just now</span>
                    </Show>
                  </div>
                </div>
              </Match>

              <Match when={step() === 2}>
                <div>
                  <h3 class="mb-1 text-xs font-medium">2. First project</h3>
                  <p class="mb-3 text-xs text-muted-foreground">
                    Link your first project to raum to get started.
                  </p>

                  <div class="mb-2 grid gap-1">
                    <span class="text-xs text-muted-foreground">Root directory</span>
                    <div class="flex items-center gap-2">
                      <div class="flex flex-1 items-center gap-1.5 h-7 rounded-md bg-selected px-2">
                        <FolderIcon class="size-3 shrink-0 text-muted-foreground/60" />
                        <input
                          type="text"
                          class="flex-1 min-w-0 bg-transparent font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
                          placeholder="~/path/to/repo"
                          value={tildify(projectPath())}
                          readOnly
                          data-testid="onboarding-project-path"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void pickDirectory()}
                      >
                        Browse…
                      </Button>
                    </div>
                  </div>

                  <TextField class="mb-3" value={projectName()} onChange={setProjectName}>
                    <TextFieldLabel class="text-xs text-muted-foreground">Name</TextFieldLabel>
                    <TextFieldInput type="text" placeholder="Project name" class="h-8" />
                  </TextField>

                  <Show when={projectError()}>
                    <Alert variant="destructive" class="mb-2 text-xs">
                      <AlertDescription>{projectError()}</AlertDescription>
                    </Alert>
                  </Show>

                  <Show when={registered()}>
                    {(item) => (
                      <div
                        class="rounded-md bg-success/10 p-2 text-xs text-success"
                        data-testid="onboarding-project-registered"
                      >
                        Registered <strong>{item().name || item().slug}</strong> at{" "}
                        <code>{tildify(item().rootPath)}</code>.
                      </div>
                    )}
                  </Show>
                </div>
              </Match>

              <Match when={step() === 3}>
                <div>
                  <h3 class="mb-1 text-xs font-medium">3. Try a harness</h3>
                  <p class="mb-3 text-xs text-muted-foreground">
                    Launch one in your project to see it work. You can spawn more from the top bar
                    later.
                  </p>

                  <Show
                    when={availableHarnesses().length > 0}
                    fallback={
                      <div class="rounded-md border border-border bg-card/40 p-3 text-xs text-muted-foreground">
                        No harnesses found. Install one from the previous step, or skip — you can
                        come back to this anytime.
                      </div>
                    }
                  >
                    <div class="grid grid-cols-3 gap-2" data-testid="onboarding-harness-cards">
                      <For each={availableHarnesses()}>
                        {(h) => (
                          <HarnessCard
                            status={h}
                            spawning={spawningKinds().has(h.kind)}
                            error={spawnErrors()[h.kind]}
                            onSpawn={() => void spawnHarness(h.kind)}
                          />
                        )}
                      </For>
                    </div>
                  </Show>

                  <div class="mt-3 rounded-md border border-info/30 bg-info/10 p-2 text-[11px] text-info">
                    Sessions survive app and OS restarts — close the window whenever, raum
                    reattaches on next launch.
                  </div>
                </div>
              </Match>
            </Switch>
          </div>

          <footer class="flex items-center justify-between border-t border-border px-8 py-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void markOnboarded()}
              disabled={finishing()}
              data-testid="onboarding-skip"
            >
              Skip
            </Button>
            <div class="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={back}
                disabled={step() === 0}
              >
                Back
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void next()}
                disabled={!canAdvance() || finishing()}
                data-testid="onboarding-next"
              >
                {step() === 2 && projectBusy() ? "Registering…" : step() === 3 ? "Finish" : "Next"}
              </Button>
            </div>
          </footer>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
};

export default OnboardingWizard;
