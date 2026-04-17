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

export interface HarnessHealthEntry {
  kind: HarnessIconKind;
  setup: SetupActionReport[] | null;
  setupOk: boolean | null;
  selftest: SelftestReport | null;
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
export function recordHarnessSetup(
  kind: HarnessIconKind,
  setup: SetupActionReport[],
  setupOk: boolean,
): void {
  setHealth((prev) => {
    const existing: HarnessHealthEntry = prev[kind] ?? {
      kind,
      setup: null,
      setupOk: null,
      selftest: null,
    };
    return {
      ...prev,
      [kind]: { ...existing, setup, setupOk },
    };
  });
}

/** Record the outcome of a single selftest run. */
export function recordHarnessSelftest(kind: HarnessIconKind, report: SelftestReport): void {
  setHealth((prev) => {
    const existing: HarnessHealthEntry = prev[kind] ?? {
      kind,
      setup: null,
      setupOk: null,
      selftest: null,
    };
    return {
      ...prev,
      [kind]: { ...existing, selftest: report },
    };
  });
}
