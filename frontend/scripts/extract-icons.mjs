/**
 * Regenerates src/lib/vscode-icons-subset.json.
 *
 * Run after adding an icon name to EXT_MAP, FILENAME_MAP, or SUFFIX_RULES in
 * src/lib/fileTypeIcon.tsx:
 *
 *   bun run scripts/extract-icons.mjs
 */

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const full = require("@iconify-json/vscode-icons/icons.json");

// Keep in sync with the icon names used in fileTypeIcon.tsx.
const NEEDED = new Set([
  // EXT_MAP values
  "file-type-typescript",
  "file-type-typescriptdef",
  "file-type-js-official",
  "file-type-reactjs",
  "file-type-reactts",
  "file-type-rust",
  "file-type-python",
  "file-type-go",
  "file-type-java",
  "file-type-kotlin",
  "file-type-swift",
  "file-type-ruby",
  "file-type-php",
  "file-type-c",
  "file-type-cheader",
  "file-type-cpp",
  "file-type-cppheader",
  "file-type-csharp",
  "file-type-html",
  "file-type-css",
  "file-type-scss",
  "file-type-less",
  "file-type-vue",
  "file-type-svelte",
  "file-type-json",
  "file-type-json5",
  "file-type-toml",
  "file-type-yaml",
  "file-type-xml",
  "file-type-markdown",
  "file-type-shell",
  "file-type-sql",
  "file-type-sqlite",
  "file-type-graphql",
  "file-type-svg",
  "file-type-image",
  "file-type-pdf2",
  "file-type-text",
  "file-type-log",
  "file-type-zip",
  "file-type-wasm",
  // FILENAME_MAP values
  "file-type-docker",
  "file-type-git",
  "file-type-npm",
  "file-type-yarn",
  "file-type-pnpm",
  "file-type-cmake",
  "file-type-tsconfig",
  // SUFFIX_RULES values
  "file-type-testts",
  "file-type-vite",
  "file-type-vitest",
  "file-type-tailwind",
  "file-type-config",
  "file-type-cargo",
  // fallback is rendered inline in FileTypeIcon — no icon name needed.
]);

const missing = [...NEEDED].filter((n) => !full.icons[n]);
if (missing.length > 0) {
  console.error("Missing icons in vscode-icons package:", missing);
  process.exit(1);
}

const subset = {
  prefix: full.prefix,
  icons: Object.fromEntries([...NEEDED].map((n) => [n, full.icons[n]])),
  width: full.width,
  height: full.height,
};

const outPath = new URL("../src/lib/vscode-icons-subset.json", import.meta.url).pathname;
writeFileSync(outPath, JSON.stringify(subset));
console.log(
  `Written ${Object.keys(subset.icons).length} icons, ${JSON.stringify(subset).length} bytes → ${outPath}`,
);
