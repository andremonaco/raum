// Reconciles xterm.js scrollback with tmux's lossless `history-limit` after
// heavy bursts. tmux's attached client (the PTY raum reads from) drops to
// redraw-compression when its kernel PTY buffer stays full — intermediate
// scroll lines never reach xterm, but tmux retains them in its per-pane
// history buffer (100 000 lines). This module finds where xterm's tail
// overlaps tmux's full capture and returns the missing tail-end so the
// pane can append it with a visible marker.

/// How many trailing lines of xterm scrollback to use as the splice anchor.
/// Wide enough to span >> one screen even on tall windows (so any plausible
/// match window is found), small enough that the per-quiet diff stays cheap.
export const SPLICE_TAIL_LINES = 64;

export interface SpliceResult {
  /// Number of tmux history lines that appear *after* the matched anchor —
  /// i.e. the lines xterm is missing. `0` means xterm is already caught up.
  missingCount: number;
  /// Slice of `tmuxLines` from the first missing line through the end.
  /// Empty array when `missingCount === 0` or when no anchor matched.
  missingLines: string[];
  /// Index in `tmuxLines` where xterm's last `SPLICE_TAIL_LINES` matched.
  /// `-1` means no overlap was found — caller should skip recovery this
  /// round rather than risk duplicating content.
  matchIndex: number;
}

/// Normalise a captured line: strip a trailing `\r` (from tmux's CRLF-ish
/// output on some paths) and trailing spaces (tmux pads to pane width).
/// Empty lines stay empty so blank-row alignment still works.
function normalise(line: string): string {
  let end = line.length;
  while (end > 0) {
    const ch = line.charCodeAt(end - 1);
    if (ch === 0x20 || ch === 0x0d || ch === 0x09) {
      end -= 1;
      continue;
    }
    break;
  }
  return end === line.length ? line : line.slice(0, end);
}

/// Find the best splice point between xterm's tail and tmux's full capture.
///
/// Strategy: walk tmux's lines from the **bottom** up to ~2× the tail
/// length, looking for the deepest position where xterm's last K lines line
/// up with tmux's lines ending at that position. Walking from the bottom
/// gives us the most-recent match, which is what we want — older matches
/// would re-recover lines we've already shown.
///
/// Returns `matchIndex = -1` when there's no confident overlap (e.g. the
/// xterm tail is too short, content has diverged, or tmux's capture is
/// shorter than the tail). Callers should treat that as "skip this round";
/// the next quiet window will retry.
export function findSplicePoint(xtermTail: string[], tmuxLines: string[]): SpliceResult {
  const empty: SpliceResult = { missingCount: 0, missingLines: [], matchIndex: -1 };

  if (xtermTail.length === 0 || tmuxLines.length === 0) return empty;

  const tail = xtermTail.map(normalise);
  // Trim the tail of empty trailing rows — xterm pads its visible area with
  // blanks; matching those would be useless and tmux's capture won't have
  // them after the cursor row.
  let tailEnd = tail.length;
  while (tailEnd > 0 && tail[tailEnd - 1] === "") tailEnd -= 1;
  if (tailEnd === 0) return empty;
  const tailTrimmed = tail.slice(0, tailEnd);

  const captured = tmuxLines.map(normalise);
  // Also trim trailing empty rows from tmux capture so the cursor's blank
  // padding doesn't move the anchor.
  let capEnd = captured.length;
  while (capEnd > 0 && captured[capEnd - 1] === "") capEnd -= 1;
  if (capEnd === 0) return empty;
  const cap = captured.slice(0, capEnd);

  // We require at least a few non-empty lines of overlap to consider a
  // match valid — single-line matches are too easy to hit by chance on
  // e.g. blank prompts. `pulumi up` style output produces dozens of
  // distinct lines so this is comfortably reachable in practice.
  const MIN_MATCH = Math.min(4, tailTrimmed.length);

  // Walk from the bottom of tmux capture: find the deepest end-position
  // where cap[endPos - K .. endPos] === tailTrimmed.slice(-K), preferring
  // larger K (longer overlap = more confidence).
  const maxK = Math.min(tailTrimmed.length, cap.length);
  for (let endPos = cap.length; endPos >= MIN_MATCH; endPos -= 1) {
    // Try the longest possible overlap ending at endPos.
    const maxOverlap = Math.min(maxK, endPos);
    for (let k = maxOverlap; k >= MIN_MATCH; k -= 1) {
      let matched = true;
      for (let i = 0; i < k; i += 1) {
        if (cap[endPos - k + i] !== tailTrimmed[tailTrimmed.length - k + i]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        // `endPos` is the exclusive index just past xterm's last visible
        // line in tmux's capture. Everything after that (cap[endPos..])
        // is content xterm missed.
        const missingLines = cap.slice(endPos);
        return {
          missingCount: missingLines.length,
          missingLines,
          matchIndex: endPos - 1,
        };
      }
    }
  }
  return empty;
}

/// Render the marker line announcing recovered content. Uses ANSI SGR for
/// the dim style so it stands out without color noise.
///
/// `count` is presented with thousands separators so 1,243 reads cleanly.
export function formatRecoveryMarker(count: number): string {
  const formatted = count.toLocaleString("en-US");
  // Dim (SGR 2) + reset (SGR 0); leading + trailing newline so the marker
  // sits on its own row even if the cursor was mid-line.
  return `\r\n\x1b[2m── ${formatted} line${count === 1 ? "" : "s"} recovered from tmux history ──\x1b[0m\r\n`;
}

/// Render the full byte payload to write into xterm: marker plus the
/// recovered lines, joined with CRLF. Trailing CRLF leaves the cursor on
/// a fresh line so the user's next prompt repaints cleanly.
export function renderRecoveryPayload(missingLines: string[]): string {
  if (missingLines.length === 0) return "";
  const marker = formatRecoveryMarker(missingLines.length);
  const body = missingLines.join("\r\n");
  return `${marker}${body}\r\n`;
}
