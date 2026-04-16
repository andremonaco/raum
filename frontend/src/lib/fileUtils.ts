/**
 * Known binary / non-text file extensions that the in-app CodeMirror editor
 * cannot meaningfully display. Paths whose extension matches this set are
 * silently blocked from opening in `FileEditorModal`.
 *
 * Intentionally a blocklist rather than an allowlist so that novel text-based
 * formats (`.astro`, `.mdx`, new config formats…) open by default.
 */
const BINARY_EXTENSIONS = new Set([
  // Images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "webp",
  "tiff",
  "tif",
  "avif",
  "heic",
  "heif",
  "raw",
  "cr2",
  "nef",
  // Video
  "mp4",
  "mov",
  "avi",
  "mkv",
  "wmv",
  "flv",
  "webm",
  "m4v",
  // Audio
  "mp3",
  "wav",
  "ogg",
  "flac",
  "aac",
  "m4a",
  "opus",
  "wma",
  // Documents / office
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "pages",
  "numbers",
  "key",
  "odt",
  "ods",
  "odp",
  // Archives / packages
  "zip",
  "tar",
  "gz",
  "bz2",
  "7z",
  "rar",
  "xz",
  "zst",
  "dmg",
  "iso",
  "pkg",
  "deb",
  "rpm",
  // Compiled / binary
  "exe",
  "dll",
  "so",
  "dylib",
  "a",
  "o",
  "out",
  "bin",
  "wasm",
  // JVM
  "class",
  "jar",
  "war",
  "ear",
  // Fonts
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  // Databases
  "sqlite",
  "db",
  "sqlite3",
  // Design tools
  "psd",
  "ai",
  "sketch",
  "fig",
  "xd",
]);

/**
 * Returns `true` if the path points to a text / code file that the in-app
 * editor can display. Returns `false` for:
 *   • Directory paths (trailing `/`, as reported by `git status --porcelain=v2`)
 *   • Files whose extension is in the binary blocklist above
 *
 * Files with no extension (Makefile, Dockerfile, .gitignore, etc.) are
 * considered editable.
 */
export function isEditableFile(path: string): boolean {
  if (path.endsWith("/")) return false;
  const name = path.split("/").pop() ?? "";
  if (!name) return false;
  const dotIdx = name.lastIndexOf(".");
  // No extension or leading-dot only (.gitignore, .env) → treat as text
  if (dotIdx <= 0) return true;
  const ext = name.slice(dotIdx + 1).toLowerCase();
  return !BINARY_EXTENSIONS.has(ext);
}
