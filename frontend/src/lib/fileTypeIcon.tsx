/**
 * File-type icon helper for the git staging view.
 *
 * Uses @iconify-icon/solid (web-component wrapper) + @iconify-json/vscode-icons
 * (the same icon set VSCode's Material Icon Theme uses). The full collection is
 * registered once at module load time so every icon is available offline with
 * no network requests.
 */

import { Show, type Component } from "solid-js";
import { Icon, addCollection } from "@iconify-icon/solid";
// Only the 55 icons actually referenced below — 94 kB vs the full 3.6 MB
// collection. If you add an icon to EXT_MAP/FILENAME_MAP/SUFFIX_RULES, run:
//   node scripts/extract-icons.mjs
// to regenerate this file.
// @ts-ignore — JSON import
import vscodeIconsSubset from "./vscode-icons-subset.json";
addCollection(vscodeIconsSubset as Parameters<typeof addCollection>[0]);

// ---------------------------------------------------------------------------
// Extension → icon ID mapping
// ---------------------------------------------------------------------------

const PREFIX = "vscode-icons:";

/** Map of lowercase file extension → vscode-icons icon name (no prefix). */
const EXT_MAP: Record<string, string> = {
  // TypeScript
  ts: "file-type-typescript",
  tsx: "file-type-reactts",
  mts: "file-type-typescript",
  cts: "file-type-typescript",
  // TypeScript declaration
  "d.ts": "file-type-typescriptdef",
  "d.mts": "file-type-typescriptdef",
  // JavaScript
  js: "file-type-js-official",
  jsx: "file-type-reactjs",
  mjs: "file-type-js-official",
  cjs: "file-type-js-official",
  // Rust
  rs: "file-type-rust",
  // Python
  py: "file-type-python",
  pyi: "file-type-python",
  pyw: "file-type-python",
  // Go
  go: "file-type-go",
  // Java
  java: "file-type-java",
  class: "file-type-java",
  jar: "file-type-java",
  // Kotlin
  kt: "file-type-kotlin",
  kts: "file-type-kotlin",
  // Swift
  swift: "file-type-swift",
  // Ruby
  rb: "file-type-ruby",
  // PHP
  php: "file-type-php",
  // C / C++
  c: "file-type-c",
  h: "file-type-cheader",
  cpp: "file-type-cpp",
  cc: "file-type-cpp",
  cxx: "file-type-cpp",
  hpp: "file-type-cppheader",
  hxx: "file-type-cppheader",
  // C#
  cs: "file-type-csharp",
  // HTML
  html: "file-type-html",
  htm: "file-type-html",
  // CSS
  css: "file-type-css",
  scss: "file-type-scss",
  sass: "file-type-scss",
  less: "file-type-less",
  // UI frameworks
  vue: "file-type-vue",
  svelte: "file-type-svelte",
  // Data / config
  json: "file-type-json",
  jsonc: "file-type-json",
  json5: "file-type-json5",
  toml: "file-type-toml",
  yaml: "file-type-yaml",
  yml: "file-type-yaml",
  xml: "file-type-xml",
  // Docs
  md: "file-type-markdown",
  mdx: "file-type-markdown",
  // Shell
  sh: "file-type-shell",
  bash: "file-type-shell",
  zsh: "file-type-shell",
  fish: "file-type-shell",
  // SQL
  sql: "file-type-sql",
  sqlite: "file-type-sqlite",
  // GraphQL
  graphql: "file-type-graphql",
  gql: "file-type-graphql",
  // SVG / Images
  svg: "file-type-svg",
  png: "file-type-image",
  jpg: "file-type-image",
  jpeg: "file-type-image",
  gif: "file-type-image",
  webp: "file-type-image",
  ico: "file-type-image",
  bmp: "file-type-image",
  tiff: "file-type-image",
  tif: "file-type-image",
  // Docs
  pdf: "file-type-pdf2",
  txt: "file-type-text",
  log: "file-type-log",
  // Archives
  zip: "file-type-zip",
  tar: "file-type-zip",
  gz: "file-type-zip",
  bz2: "file-type-zip",
  xz: "file-type-zip",
  "7z": "file-type-zip",
  // WebAssembly
  wasm: "file-type-wasm",
  // Fonts
  woff: "file-type-text",
  woff2: "file-type-text",
  ttf: "file-type-text",
};

/** Whole-filename overrides checked before extension lookup. */
const FILENAME_MAP: Record<string, string> = {
  Dockerfile: "file-type-docker",
  "docker-compose.yml": "file-type-docker",
  "docker-compose.yaml": "file-type-docker",
  ".gitignore": "file-type-git",
  ".gitattributes": "file-type-git",
  ".gitmodules": "file-type-git",
  "package.json": "file-type-npm",
  "package-lock.json": "file-type-npm",
  "yarn.lock": "file-type-yarn",
  "pnpm-lock.yaml": "file-type-pnpm",
  "Cargo.toml": "file-type-rust",
  "Cargo.lock": "file-type-rust",
  "go.mod": "file-type-go",
  "go.sum": "file-type-go",
  Makefile: "file-type-cmake",
  "tsconfig.json": "file-type-tsconfig",
  "jsconfig.json": "file-type-tsconfig",
};

/** Suffix patterns checked when whole-filename and extension both miss. */
const SUFFIX_RULES: Array<[RegExp, string]> = [
  [/\.test\.(ts|tsx|js|jsx)$/, "file-type-testts"],
  [/\.spec\.(ts|tsx|js|jsx)$/, "file-type-testts"],
  [/tsconfig.*\.json$/, "file-type-tsconfig"],
  [/vite\.config\./, "file-type-vite"],
  [/vitest\.config\./, "file-type-vitest"],
  [/tailwind\.config\./, "file-type-tailwind"],
  [/\.env(\.|$)/, "file-type-config"],
  [/\.lock$/, "file-type-cargo"], // generic lock fallback
];

/**
 * Return the full Iconify icon ID (e.g. `"vscode-icons:file-type-typescript"`)
 * for a given filename, or `null` when no rule matches — the caller should
 * render a generic inline file glyph in that case (vscode-icons' own
 * `default-file` is a filled badge that collapses to an ugly square under
 * `mode="mask"`).
 *
 * The `filename` may be a bare name or a relative path — only the basename is
 * inspected.
 */
export function getFileIconId(filename: string): string | null {
  // Use only the basename so paths like "src/foo.ts" work correctly.
  const base = filename.split("/").pop() ?? filename;

  // 1. Whole-filename match.
  if (base in FILENAME_MAP) return PREFIX + FILENAME_MAP[base]!;

  // 2. Suffix-pattern rules (e.g. *.test.ts, tsconfig.*.json).
  for (const [re, icon] of SUFFIX_RULES) {
    if (re.test(base)) return PREFIX + icon;
  }

  // 3. Extension lookup — try longest extension first (e.g. "d.ts" before "ts").
  const parts = base.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".").toLowerCase();
    if (ext in EXT_MAP) return PREFIX + EXT_MAP[ext]!;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface FileTypeIconProps {
  /** Filename or relative path — only the basename is used for icon lookup. */
  name: string;
  class?: string;
  width?: number | string;
  height?: number | string;
}

/**
 * Renders a 14×14 px file-type icon for the given filename.
 *
 * Icons render in their native vscode-icons colors (JS yellow, CSS violet, TS
 * blue, …). We deliberately do NOT use `mode="mask"` — most vscode-icons are
 * badge-style with a full-canvas background rectangle, which under a CSS mask
 * collapses every icon to a solid square. When no rule matches the filename,
 * we fall back to a generic stroke-based "paper" glyph that inherits
 * `currentColor`.
 */
export const FileTypeIcon: Component<FileTypeIconProps> = (props) => {
  const iconId = () => getFileIconId(props.name);
  return (
    <Show
      when={iconId()}
      fallback={
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          width={props.width ?? 14}
          height={props.height ?? 14}
          class={props.class}
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      }
    >
      {(id) => (
        <Icon
          icon={id()}
          width={props.width ?? 14}
          height={props.height ?? 14}
          class={props.class}
        />
      )}
    </Show>
  );
};
