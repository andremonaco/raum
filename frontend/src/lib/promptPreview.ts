/**
 * Formatting for the last-prompt preview shown in tab hover tooltips.
 *
 * A submitted prompt can be arbitrarily long (pasted JSON blobs, stack
 * traces, whole files). Rendering it verbatim grows the tooltip past the
 * viewport, so the preview is clamped on both axes: at most
 * `MAX_PREVIEW_LINES` lines and `MAX_PREVIEW_CHARS` characters, with an
 * ellipsis marking the cut. The tooltip itself still needs `overflow-wrap`
 * for unbroken tokens (URLs, hashes) that exceed its width.
 */

export const MAX_PREVIEW_CHARS = 220;
export const MAX_PREVIEW_LINES = 6;

const ELLIPSIS = "…";

/** Trailing run we're willing to drop to end the preview on a word boundary. */
const WORD_BOUNDARY_LOOKBACK = 24;

export function formatPromptPreview(
  text: string | null | undefined,
  maxChars: number = MAX_PREVIEW_CHARS,
  maxLines: number = MAX_PREVIEW_LINES,
): string | undefined {
  if (!text) return undefined;

  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return undefined;

  let truncated = false;
  const lines = normalized.split("\n");
  let body = normalized;
  if (lines.length > maxLines) {
    body = lines.slice(0, maxLines).join("\n").trimEnd();
    truncated = true;
  }

  if (body.length > maxChars) {
    let cut = body.slice(0, maxChars);
    const boundary = cut.search(/\s+\S*$/);
    if (boundary > maxChars - WORD_BOUNDARY_LOOKBACK) {
      cut = cut.slice(0, boundary);
    }
    body = cut.trimEnd();
    truncated = true;
  }

  return truncated ? `${body}${ELLIPSIS}` : body;
}
