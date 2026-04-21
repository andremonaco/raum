import { homeDir as tauriHomeDir } from "@tauri-apps/api/path";

let homeDir: string | null = null;

export async function initHomeDir(): Promise<void> {
  try {
    const raw = await tauriHomeDir();
    homeDir = raw.replace(/\/+$/, "") || null;
  } catch {
    homeDir = null;
  }
}

export function setHomeDirForTesting(next: string | null): void {
  homeDir = next === null ? null : next.replace(/\/+$/, "") || null;
}

export function tildify(path: string | null | undefined): string {
  if (!path) return "";
  if (!homeDir) return path;
  if (path === homeDir) return "~";
  if (path.startsWith(`${homeDir}/`)) return `~${path.slice(homeDir.length)}`;
  return path;
}
