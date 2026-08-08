/**
 * One-line rendering of a harness permission request.
 *
 * The three harnesses hand us three different payload shapes on the
 * `notification-event` bus:
 *
 *   * Claude Code — `{ tool_name, tool_input: { command | file_path | … } }`
 *   * Codex       — same field names; `apply_patch` stuffs the RAW PATCH TEXT
 *                   into `tool_input.command` (no structured file field).
 *   * OpenCode    — `{ permission, patterns, metadata: { command | filepath | … } }`
 *
 * `permissionSummary` collapses all of them to `{ tool, head }` for the
 * "Needs you" rail and the OS banner body. It is pure and MUST NOT throw:
 * every payload here crossed an IPC boundary and may be anything at all.
 */

/** Max length of `head`, including the ellipsis. */
const HEAD_MAX = 80;

/** Tools whose interesting field is a shell command. */
const COMMAND_TOOLS = new Set(["bash", "shell", "local_shell", "unified_exec", "run_command"]);

/** Tools whose interesting field is a file path. */
const PATH_TOOLS = new Set(["edit", "write", "read", "multiedit", "notebookedit"]);

export interface PermissionSummary {
  /** Tool / capability being requested, e.g. `Bash`, `apply_patch`, `edit`. */
  tool: string;
  /** Single-line detail: the command, the file path, or `""`. */
  head: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** First non-empty line, whitespace-collapsed, truncated to {@link HEAD_MAX}. */
function head(value: unknown): string {
  const line =
    str(value)
      .split("\n")
      .find((l) => l.trim().length > 0) ?? "";
  const clean = line.trim().replace(/\s+/g, " ");
  return clean.length > HEAD_MAX ? `${clean.slice(0, HEAD_MAX - 1)}…` : clean;
}

/** First string entry of an array-ish value. */
function firstString(value: unknown): string {
  return Array.isArray(value) ? str(value.find((v) => str(v))) : "";
}

/**
 * Codex sends the whole patch as `tool_input.command`. Prefer the file the
 * patch touches over `*** Begin Patch`, which tells the user nothing.
 */
function patchHead(patch: string): string {
  const file = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(patch);
  return head(file ? file[1] : patch);
}

/** Claude Code / Codex: `{ tool_name, tool_input }`. */
function fromToolInput(payload: Record<string, unknown>): PermissionSummary {
  const tool = str(payload.tool_name) || "permission";
  const input = asRecord(payload.tool_input) ?? {};
  const key = tool.toLowerCase();

  if (key === "apply_patch") return { tool, head: patchHead(str(input.command)) };
  if (COMMAND_TOOLS.has(key)) return { tool, head: head(input.command) };
  if (PATH_TOOLS.has(key)) {
    return { tool, head: head(input.file_path ?? input.filePath ?? input.path) };
  }
  // MCP tools and anything unknown: take whatever reads like a subject.
  return {
    tool,
    head: head(input.command ?? input.file_path ?? input.url ?? input.description),
  };
}

/** OpenCode: `{ permission, patterns, metadata }`. `metadata` is schema-free. */
function fromOpenCode(payload: Record<string, unknown>): PermissionSummary {
  const tool = str(payload.permission) || "permission";
  const meta = asRecord(payload.metadata) ?? {};
  // The TUI back-fills `metadata.input` from the matching tool call; we may
  // or may not have it depending on when the event was observed.
  const input = asRecord(meta.input) ?? {};
  const detail =
    meta.command ??
    input.command ??
    meta.filepath ??
    input.filepath ??
    input.filePath ??
    meta.url ??
    input.url;
  return { tool, head: head(detail) || head(firstString(payload.patterns)) };
}

/**
 * Summarise a permission request for display. Never throws; unknown or
 * malformed payloads degrade to `{ tool: "permission", head: "" }`.
 */
export function permissionSummary(
  harness: string,
  payload: Record<string, unknown> | null | undefined,
): PermissionSummary {
  try {
    const p = asRecord(payload);
    if (!p) return { tool: "permission", head: "" };
    // Shape-sniff rather than trust `harness`: the wire tag has been wrong
    // before (SSE events carry raum's pane session, not the harness's).
    if ("tool_name" in p) return fromToolInput(p);
    if (harness === "opencode" || "permission" in p) return fromOpenCode(p);
    return fromToolInput(p);
  } catch {
    return { tool: "permission", head: "" };
  }
}
