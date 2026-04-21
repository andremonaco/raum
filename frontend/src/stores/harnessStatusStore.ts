/**
 * Singleton harness-availability probe.
 *
 * `harnesses_check` shells out to four binaries (`shell`, `claude`, `codex`,
 * `opencode`) and parses `--version`. Cold-start of the Node-based CLIs makes
 * each call slow enough to be visible in the UI, so we run it once at app
 * boot and reuse the result everywhere (Settings → Harnesses, the onboarding
 * wizard, the terminal-grid spawn menu). Consumers can call
 * `refreshHarnessReport()` to re-probe in the background.
 *
 * Phase 2 extends the store with per-harness `SetupReport` / `SelftestReport`
 * state for the Harness Health panel. These live entirely client-side today —
 * the backend `plan` / `selftest` commands are invoked on demand when the
 * user opens Settings. Background refresh keeps them consistent with the
 * native adapters.
 */

import { createResource, createRoot, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { HarnessIconKind } from "../components/icons";

export interface HarnessStatus {
  kind: HarnessIconKind;
  binary: string;
  found: boolean;
  version: string | null;
  raw: string | null;
  resolvedPath: string | null;
  minimum: string | null;
  meetsMinimum: boolean | null;
  supportsNativeEvents: boolean;
  installHint: string | null;
  settingsPath: string | null;
}

export interface HarnessReport {
  harnesses: HarnessStatus[];
}

// -- Phase 2: SetupReport / SelftestReport surface ---------------------------

export type ActionOutcomeTag = "applied" | "skipped" | "failed";

/**
 * Per-harness setup + selftest record kept in the store. The backend
 * `SetupReport` is serialised kebab-case matching `raum_core::harness`.
 */
export interface SetupActionReport {
  /** Kebab-case tag mirroring `ActionOutcome`. */
  outcome: ActionOutcomeTag;
  /** Optional human-readable detail (reason when skipped / error text when failed). */
  detail: string | null;
  /** Kebab-case tag mirroring `SetupAction` ("write-json", "write-toml", …). */
  actionKind: string;
}

export interface SelftestReport {
  ok: boolean;
  detail: string;
  elapsedMs: number;
}

/**
 * One managed config file for a harness. Mirrors
 * `raum_core::harness::ConfigPathEntry` (serde kebab-case).
 */
export interface ConfigPathEntry {
  kind: "project" | "user";
  label: string;
  /** Absolute on-disk path. */
  path: string;
  exists: boolean;
  raumManaged: boolean;
}

/**
 * Pure-read scan of one harness's install state. Mirrors
 * `raum_core::harness::ScanReport`.
 */
export interface ScanReport {
  harness: HarnessIconKind;
  binary: string;
  binaryOnPath: boolean;
  raumHooksInstalled: boolean;
  configPaths: ConfigPathEntry[];
  reasonIfNotInstalled: string | null;
  note: string | null;
}

export interface HarnessHealthEntry {
  kind: HarnessIconKind;
  setup: SetupActionReport[] | null;
  setupOk: boolean | null;
  selftest: SelftestReport | null;
  /** Latest filesystem scan (Phase 7). `null` when the panel has not scanned yet. */
  scan: ScanReport | null;
}

type HarnessHealthMap = Record<string, HarnessHealthEntry>;

async function fetchHarnessReport(): Promise<HarnessReport> {
  try {
    return await invoke<HarnessReport>("harnesses_check");
  } catch (e) {
    console.warn("harnesses_check failed", e);
    return { harnesses: [] };
  }
}

const { report, refetch, health, setHealth } = createRoot(() => {
  const [report, { refetch }] = createResource<HarnessReport>(fetchHarnessReport);
  const [health, setHealth] = createSignal<HarnessHealthMap>({});
  return { report, refetch, health, setHealth };
});

export const harnessReport = report;
export const refreshHarnessReport = refetch;
export const harnessHealth = health;

/**
 * Record the outcome of a `SetupReport` for a harness, merging into the
 * existing record so repeated selftests don't clobber the last known
 * setup state.
 */
const emptyEntry = (kind: HarnessIconKind): HarnessHealthEntry => ({
  kind,
  setup: null,
  setupOk: null,
  selftest: null,
  scan: null,
});

export function recordHarnessSetup(
  kind: HarnessIconKind,
  setup: SetupActionReport[],
  setupOk: boolean,
): void {
  setHealth((prev) => {
    const existing: HarnessHealthEntry = prev[kind] ?? emptyEntry(kind);
    return {
      ...prev,
      [kind]: { ...existing, setup, setupOk },
    };
  });
}

/** Record the outcome of a single selftest run. */
export function recordHarnessSelftest(kind: HarnessIconKind, report: SelftestReport): void {
  setHealth((prev) => {
    const existing: HarnessHealthEntry = prev[kind] ?? emptyEntry(kind);
    return {
      ...prev,
      [kind]: { ...existing, selftest: report },
    };
  });
}

/** Record a fresh filesystem scan (Phase 7). */
export function recordHarnessScan(kind: HarnessIconKind, scan: ScanReport): void {
  setHealth((prev) => {
    const existing: HarnessHealthEntry = prev[kind] ?? emptyEntry(kind);
    return {
      ...prev,
      [kind]: { ...existing, scan },
    };
  });
}

// -- Phase 6: live subscriptions --------------------------------------------

/**
 * Wire shape of the `harness-setup-report` Tauri event. Matches the
 * serde serialisation of `raum_core::harness::SetupReport` — kebab-case
 * action tags + outcome tags, `harness` as the adapter kind.
 */
interface WireSetupReport {
  harness?: string | null;
  ok: boolean;
  actions: Array<{
    action: { kind: string; [key: string]: unknown };
    outcome:
      | { outcome: "applied" }
      | { outcome: "skipped"; reason: string }
      | { outcome: "failed"; error: string };
  }>;
}

interface WireSelftestReport {
  harness?: string | null;
  ok: boolean;
  detail: string;
  elapsed_ms: number;
}

function kindFromWire(wire: string | null | undefined): HarnessIconKind | null {
  switch (wire) {
    case "claude-code":
      return "claude-code";
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
    case "shell":
      return "shell";
    default:
      return null;
  }
}

function projectSetupReport(report: WireSetupReport): SetupActionReport[] {
  return report.actions.map((a) => {
    const out = a.outcome as
      | { outcome: "applied" }
      | { outcome: "skipped"; reason: string }
      | { outcome: "failed"; error: string };
    if (out.outcome === "applied") {
      return { actionKind: a.action.kind, outcome: "applied", detail: null };
    }
    if (out.outcome === "skipped") {
      return { actionKind: a.action.kind, outcome: "skipped", detail: out.reason };
    }
    return { actionKind: a.action.kind, outcome: "failed", detail: out.error };
  });
}

// Fire listener registration on module load. The listener registration
// is async so we can't await it here; `void` the promise — late events
// will re-render on arrival regardless of whether the panel was
// already open.
void (async () => {
  try {
    await listen<WireSetupReport>("harness-setup-report", (event) => {
      const kind = kindFromWire(event.payload.harness);
      if (!kind) return;
      recordHarnessSetup(kind, projectSetupReport(event.payload), event.payload.ok);
    });
    await listen<WireSelftestReport>("harness-selftest-report", (event) => {
      const kind = kindFromWire(event.payload.harness);
      if (!kind) return;
      recordHarnessSelftest(kind, {
        ok: event.payload.ok,
        detail: event.payload.detail,
        elapsedMs: event.payload.elapsed_ms,
      });
    });
  } catch (e) {
    console.warn("harnessStatusStore: listen failed", e);
  }
})();

/**
 * Trigger a backend-side selftest for `kind`. Resolves with the
 * fresh `SelftestReport`; the store is also updated via the
 * `harness-selftest-report` listener.
 */
/**
 * Wire shape of `harness_scan_install_state` — matches
 * `raum_core::harness::ScanReport` serialised as kebab-case.
 */
interface WireScanReport {
  harness: string;
  binary: string;
  binary_on_path: boolean;
  raum_hooks_installed: boolean;
  config_paths: Array<{
    kind: "project" | "user";
    label: string;
    path: string;
    exists: boolean;
    raum_managed: boolean;
  }>;
  reason_if_not_installed: string | null;
  note: string | null;
}

function scanFromWire(w: WireScanReport): ScanReport | null {
  const kind = kindFromWire(w.harness);
  if (!kind) return null;
  return {
    harness: kind,
    binary: w.binary,
    binaryOnPath: w.binary_on_path,
    raumHooksInstalled: w.raum_hooks_installed,
    configPaths: w.config_paths.map((c) => ({
      kind: c.kind,
      label: c.label,
      path: c.path,
      exists: c.exists,
      raumManaged: c.raum_managed,
    })),
    reasonIfNotInstalled: w.reason_if_not_installed,
    note: w.note,
  };
}

/**
 * Scan every harness's install state by invoking
 * `harness_scan_install_state`. Populates the store; returns the
 * deserialised reports so callers can render immediately.
 */
export async function scanHarnessInstallState(projectDir: string | null): Promise<ScanReport[]> {
  try {
    const wire = await invoke<WireScanReport[]>("harness_scan_install_state", {
      projectDir,
    });
    const reports = wire.map(scanFromWire).filter((r): r is ScanReport => r !== null);
    for (const r of reports) recordHarnessScan(r.harness, r);
    return reports;
  } catch (e) {
    console.warn("harness_scan_install_state invoke failed", e);
    return [];
  }
}

/**
 * Invoke `harness_install` to run `plan()` + `apply()` + `selftest()`
 * for a single harness on demand. Resolves after the store has
 * observed the resulting setup + selftest events (both emitted by
 * the backend during the invoke).
 */
export async function installHarness(args: {
  harness: HarnessIconKind;
  projectSlug?: string | null;
  worktreeId?: string | null;
}): Promise<boolean> {
  try {
    await invoke("harness_install", {
      harness: args.harness,
      projectSlug: args.projectSlug ?? null,
      worktreeId: args.worktreeId ?? null,
    });
    return true;
  } catch (e) {
    console.warn("harness_install invoke failed", e);
    return false;
  }
}

export async function runHarnessSelftest(
  kind: HarnessIconKind,
  args: { projectSlug?: string | null; worktreeId?: string | null } = {},
): Promise<SelftestReport | null> {
  try {
    const wire = await invoke<WireSelftestReport>("harness_selftest", {
      harness: kind,
      projectSlug: args.projectSlug ?? null,
      worktreeId: args.worktreeId ?? null,
    });
    const out: SelftestReport = {
      ok: wire.ok,
      detail: wire.detail,
      elapsedMs: wire.elapsed_ms,
    };
    recordHarnessSelftest(kind, out);
    return out;
  } catch (e) {
    console.warn("harness_selftest invoke failed", e);
    return null;
  }
}
