/**
 * Singleton harness-availability probe.
 *
 * `harnesses_check` shells out to four binaries (`shell`, `claude`, `codex`,
 * `opencode`) and parses `--version`. Cold-start of the Node-based CLIs makes
 * each call slow enough to be visible in the UI, so we run it once at app
 * boot and reuse the result everywhere (Settings → Harnesses, the onboarding
 * wizard, the terminal-grid spawn menu). Consumers can call
 * `refreshHarnessReport()` to re-probe in the background.
 */

import { createResource, createRoot } from "solid-js";
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

async function fetchHarnessReport(): Promise<HarnessReport> {
  try {
    return await invoke<HarnessReport>("harnesses_check");
  } catch (e) {
    console.warn("harnesses_check failed", e);
    return { harnesses: [] };
  }
}

const { report, refetch } = createRoot(() => {
  const [report, { refetch }] = createResource<HarnessReport>(fetchHarnessReport);
  return { report, refetch };
});

export const harnessReport = report;
export const refreshHarnessReport = refetch;
