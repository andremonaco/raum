/**
 * Snapshot extraction from an xterm.js buffer.
 *
 * Called once at minimize-time (lazy, zero ongoing cost). Scans the active
 * buffer backward to find the most meaningful single line:
 *
 *   - shell  → last line that matches a shell-prompt pattern (`$ cmd`, `❯ cmd`,
 *              `% cmd`, `# cmd`) — returns the command part only.
 *   - AI harnesses → last non-empty line that isn't a box-drawing / status-bar
 *              chrome character (╭ │ ╰ ┌ ├ └ ┤ ─ ━ and plain spaces).
 *   - fallback → last 3 non-empty lines joined with " ↵ ".
 *
 * Output is capped at 80 characters to fit dock chips.
 */

import { listTerminals } from "./terminalRegistry";
import type { AgentKind } from "./agentKind";

/** Strips common ANSI CSI/OSC/escape sequences from a string.
 *  Uses RegExp constructor to avoid the no-control-regex ESLint rule, since
 *  matching ESC (0x1b) and BEL (0x07) is intentional here. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07|[()][012AB]|[=>78])/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\r/g, "");
}

/** Matches `$ cmd`, `❯ cmd`, `% cmd`, `# cmd` — captures the command part. */
const SHELL_PROMPT_RE = /[$❯%#]\s+(.+)/;

/** Lines starting with these characters are TUI chrome, not meaningful content. */
const AI_CHROME_RE = /^[╭│╰┌├└┤─━ ]/;

/** How many lines to scan backward from the bottom of the buffer. */
const SCAN_DEPTH = 150;

/** Maximum character length of the returned snippet. */
const MAX_LEN = 80;

export function extractSnippet(sessionId: string | null | undefined, kind: AgentKind): string {
  if (!sessionId) return "";

  const entry = listTerminals().find((e) => e.sessionId === sessionId);
  if (!entry) return "";

  const buf = entry.terminal.buffer.active;
  const startLine = Math.max(0, buf.length - SCAN_DEPTH);
  const lines: string[] = [];

  for (let i = buf.length - 1; i >= startLine; i--) {
    const raw = buf.getLine(i)?.translateToString(true) ?? "";
    const line = stripAnsi(raw).trim();
    if (line) lines.unshift(line);
    if (lines.length >= 30) break;
  }

  if (kind === "shell") {
    // Walk backward through collected lines; return the command after the last
    // visible shell prompt.
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = SHELL_PROMPT_RE.exec(lines[i]);
      if (m) return m[1].slice(0, MAX_LEN);
    }
  } else {
    // AI harness: skip box-drawing and spinner chrome lines; return the last
    // meaningful content line (e.g. user prompt, agent response heading).
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!AI_CHROME_RE.test(line)) return line.slice(0, MAX_LEN);
    }
  }

  // Fallback: join the last three non-empty lines.
  return lines.slice(-3).join(" ↵ ").slice(0, MAX_LEN);
}
