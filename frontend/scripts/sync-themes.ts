/**
 * Build-time sync of curated VSCode themes from `tm-themes` into
 * `frontend/src/themes/catalog/`. Run via `bun run themes:sync` (or
 * `task themes:sync`).
 *
 * The catalog is checked in; this script is "run on demand" — typically when
 * we want to refresh a theme or add a new one to the curated set. CI verifies
 * the catalog isn't drifted (`git diff --exit-code frontend/src/themes/catalog`).
 *
 * For each entry in `CURATED`:
 *   - copies tm-themes/themes/<id>.json → src/themes/catalog/<id>.json
 *   - extracts the upstream license excerpt from `tm-themes/NOTICE` → LICENSES/<id>.txt
 *
 * `raum-default-dark` is hand-authored (kept under `assets/`) and copied through
 * unchanged so the boot fallback in `:root` and the runtime theme stay in sync.
 *
 * Also rewrites `src/themes/catalog/index.ts` — a typed manifest of
 * `{ id, label, type, load }` entries that the runtime walks to populate the
 * theme picker and lazy-load the chosen JSON via dynamic import.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(HERE, "..");
const TM_THEMES_DIR = join(FRONTEND_ROOT, "node_modules/tm-themes");
const CATALOG_DIR = join(FRONTEND_ROOT, "src/themes/catalog");
const LICENSES_DIR = join(CATALOG_DIR, "LICENSES");
const ASSETS_DIR = join(FRONTEND_ROOT, "src/themes/assets");

interface CuratedEntry {
  /** Stable id used in config + dynamic-import paths. */
  id: string;
  /** Source file inside `tm-themes/themes/` (without .json), or `local` for hand-authored themes in `assets/`. */
  source: string | { local: string };
  /** Display label in the picker. */
  label: string;
}

/**
 * Curated catalog. Order = display order in the picker. Dark / light grouping
 * is derived from each theme's `type` field at runtime — the picker doesn't
 * need a separate flag here.
 *
 * To add a theme: pick a stable `id` (kebab-case, used in config), point
 * `source` at the tm-themes filename, run `task themes:sync`, commit.
 */
const CURATED: readonly CuratedEntry[] = [
  // --- Hand-authored ---------------------------------------------------------
  { id: "raum-default-dark", source: { local: "raum-default-dark.json" }, label: "Default" },

  // --- Dark themes from tm-themes -------------------------------------------
  { id: "dracula", source: "dracula", label: "Dracula" },
  { id: "one-dark-pro", source: "one-dark-pro", label: "One Dark Pro" },
  { id: "tokyo-night", source: "tokyo-night", label: "Tokyo Night" },
  { id: "catppuccin-mocha", source: "catppuccin-mocha", label: "Catppuccin Mocha" },
  { id: "rose-pine", source: "rose-pine", label: "Rosé Pine" },
  { id: "nord", source: "nord", label: "Nord" },
  { id: "github-dark", source: "github-dark", label: "GitHub Dark" },
  { id: "solarized-dark", source: "solarized-dark", label: "Solarized Dark" },
  { id: "monokai", source: "monokai", label: "Monokai" },

  // --- Light themes from tm-themes ------------------------------------------
  { id: "github-light", source: "github-light", label: "GitHub Light" },
  { id: "solarized-light", source: "solarized-light", label: "Solarized Light" },
  { id: "catppuccin-latte", source: "catppuccin-latte", label: "Catppuccin Latte" },
];

interface ThemeJson {
  type?: "dark" | "light" | "hc-dark" | "hc-light" | string;
  colors?: Record<string, string>;
  tokenColors?: unknown[];
  semanticTokenColors?: Record<string, unknown>;
}

/**
 * Pull the per-file excerpt for `<id>.json` out of tm-themes' NOTICE. Each
 * entry is fenced by `===` rules; we take everything between the heading
 * matching `Files:   <id>.json` and the next fence. Returns `null` if the
 * NOTICE doesn't carry an entry for this file (some local themes won't).
 */
function extractLicense(notice: string, sourceFile: string): string | null {
  // tm-themes' NOTICE groups files per-license: `Files: a.json, b.json, c.json`.
  // Match an entry whose `Files:` line mentions our filename, then take
  // everything up to the next `===…===` rule.
  const escaped = sourceFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    String.raw`={5,}\s*\nFiles:[^\n]*\b${escaped}\b[^\n]*\n[\s\S]*?(?=\n={5,})`,
    "m",
  );
  const match = notice.match(pattern);
  return match ? match[0].trim() : null;
}

async function ensureDir(path: string): Promise<void> {
  if (!existsSync(path)) {
    await mkdir(path, { recursive: true });
  }
}

async function main(): Promise<void> {
  if (!existsSync(TM_THEMES_DIR)) {
    throw new Error(
      `tm-themes not installed at ${TM_THEMES_DIR}. Run \`bun install\` in frontend/ first.`,
    );
  }
  await ensureDir(CATALOG_DIR);
  await ensureDir(LICENSES_DIR);

  const notice = await readFile(join(TM_THEMES_DIR, "NOTICE"), "utf8");
  const tmThemesPkg = JSON.parse(await readFile(join(TM_THEMES_DIR, "package.json"), "utf8")) as {
    version?: string;
  };

  const manifestEntries: Array<{ id: string; label: string; type: string; sourceVersion: string }> =
    [];

  for (const entry of CURATED) {
    let raw: string;
    let sourceFile: string;
    let sourceVersion: string;

    if (typeof entry.source === "object" && "local" in entry.source) {
      sourceFile = entry.source.local;
      sourceVersion = "local";
      raw = await readFile(join(ASSETS_DIR, sourceFile), "utf8");
    } else {
      sourceFile = `${entry.source}.json`;
      sourceVersion = `tm-themes@${tmThemesPkg.version ?? "?"}`;
      raw = await readFile(join(TM_THEMES_DIR, "themes", sourceFile), "utf8");
    }

    // Re-stringify so curated copies are guaranteed plain JSON (no comments,
    // no trailing commas) — the runtime can `import('./<id>.json')` directly
    // without needing the JSONC parser. BYO themes still go through
    // jsonc-parser because users may load real-world `.json` files with
    // VSCode's permissive shape.
    const parsed = JSON.parse(raw) as ThemeJson;
    const minimal: ThemeJson = {
      type: parsed.type ?? "dark",
      colors: parsed.colors ?? {},
      tokenColors: parsed.tokenColors ?? [],
    };
    if (parsed.semanticTokenColors) minimal.semanticTokenColors = parsed.semanticTokenColors;

    await writeFile(join(CATALOG_DIR, `${entry.id}.json`), `${JSON.stringify(minimal, null, 2)}\n`);

    if (sourceVersion !== "local") {
      const license = extractLicense(notice, sourceFile);
      if (license) {
        await writeFile(join(LICENSES_DIR, `${entry.id}.txt`), `${license}\n`);
      } else {
        console.warn(`  (no NOTICE entry found for ${sourceFile})`);
      }
    }

    manifestEntries.push({
      id: entry.id,
      label: entry.label,
      type: minimal.type ?? "dark",
      sourceVersion,
    });

    console.log(`✓ ${entry.id.padEnd(22)} (${minimal.type}, source: ${sourceVersion})`);
  }

  await writeFile(join(CATALOG_DIR, "index.ts"), renderManifest(manifestEntries));
  console.log(
    `\nWrote ${manifestEntries.length} themes + index.ts to ${CATALOG_DIR.replace(FRONTEND_ROOT, "frontend")}.`,
  );
}

function renderManifest(
  entries: Array<{ id: string; label: string; type: string; sourceVersion: string }>,
): string {
  const lines: string[] = [];
  lines.push("/**");
  lines.push(" * Curated VSCode theme catalog. Generated by `bun run themes:sync` from");
  lines.push(" * `tm-themes` + hand-authored entries in `src/themes/assets/`.");
  lines.push(" *");
  lines.push(
    " * Do not edit by hand. To change the catalog, edit `frontend/scripts/sync-themes.ts`",
  );
  lines.push(" * and re-run `bun run themes:sync`.");
  lines.push(" */");
  lines.push("");
  lines.push('import type { RawThemeJson } from "../../lib/theme/types";');
  lines.push("");
  lines.push("export interface ThemeCatalogEntry {");
  lines.push("  /** Stable id used in config and dynamic-import paths. */");
  lines.push("  id: string;");
  lines.push("  /** Display label in the picker. */");
  lines.push("  label: string;");
  lines.push('  /** "dark" | "light" — drives `data-kb-theme` toggling and picker grouping. */');
  lines.push('  type: "dark" | "light";');
  lines.push("  /** Lazy-load the raw VSCode JSON for this theme. */");
  lines.push("  load: () => Promise<RawThemeJson>;");
  lines.push('  /** Provenance string, e.g. "tm-themes@1.12.2" or "local". */');
  lines.push("  sourceVersion: string;");
  lines.push("}");
  lines.push("");
  lines.push("export const THEME_CATALOG: readonly ThemeCatalogEntry[] = [");
  for (const e of entries) {
    const type = e.type === "light" ? "light" : "dark";
    lines.push("  {");
    lines.push(`    id: ${JSON.stringify(e.id)},`);
    lines.push(`    label: ${JSON.stringify(e.label)},`);
    lines.push(`    type: ${JSON.stringify(type)},`);
    lines.push(`    load: () => import("./${e.id}.json").then((m) => m.default as RawThemeJson),`);
    lines.push(`    sourceVersion: ${JSON.stringify(e.sourceVersion)},`);
    lines.push("  },");
  }
  lines.push("];");
  lines.push("");
  lines.push('export const DEFAULT_THEME_ID = "raum-default-dark";');
  lines.push("");
  return lines.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
