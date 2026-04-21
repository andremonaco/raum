//! Managed TOML block helper for `~/.codex/config.toml` (Phase 3).
//!
//! Codex's config file is TOML, which supports line comments. Rather than
//! parse + re-serialize the user's TOML (which would lose comment order and
//! formatting), raum delimits its owned keys with a pair of sentinel
//! comments:
//!
//! ```toml
//! # existing user content left untouched
//!
//! # <raum-managed>
//! [features]
//! codex_hooks = true
//! notify = ["/home/u/.config/raum/hooks/codex-notify.sh"]
//! # </raum-managed>
//! ```
//!
//! The helper is re-runnable:
//!
//! * Missing file → create parent dirs, write the block by itself.
//! * Existing file, no block → append the block with a leading blank line.
//! * Existing file with stale block → replace the body between the
//!   sentinels byte-for-byte; every other line is preserved verbatim.
//!
//! Writes are atomic via the same `.raum-tmp-*` temp-rename path that
//! `managed_json::atomic_write` uses (re-exported from this module).

use std::path::Path;

use thiserror::Error;

use crate::config_io::managed_json::atomic_write;

/// Opening sentinel line. Written byte-for-byte; the trailing newline is
/// part of the constant so line-based splitting round-trips cleanly.
pub const BEGIN_MARKER: &str = "# <raum-managed>";
/// Closing sentinel line.
pub const END_MARKER: &str = "# </raum-managed>";

#[derive(Debug, Error)]
pub enum ManagedTomlError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Apply `body` as the managed block inside the TOML file at `path`.
///
/// `body` is the raw TOML text that should live between the begin/end
/// markers. It is spliced verbatim — callers own serialisation (this
/// helper has no opinion on whether `body` is `[features] …` or a
/// top-level `notify = …` array).
///
/// * Missing file: creates parent dirs, writes `BEGIN_MARKER + body +
///   END_MARKER` terminated by a newline.
/// * Existing file without the sentinel pair: appends the block with a
///   leading blank line (so the file does not end in a truncated line).
/// * Existing file with a matching sentinel pair: replaces the body
///   between them and preserves every surrounding byte.
///
/// Returns [`ManagedTomlError::Io`] on any underlying filesystem error
/// (including unreadable permissions). Callers that want to refuse to
/// overwrite a malformed TOML file should parse the file themselves
/// before calling this — we do not validate the non-managed content so
/// that a user's hand-edited-but-broken TOML is not lost.
pub fn apply_managed_block(path: &Path, body: &str) -> Result<(), ManagedTomlError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let existing = if path.exists() {
        Some(std::fs::read_to_string(path)?)
    } else {
        None
    };

    let new_contents = render(existing.as_deref(), body);
    atomic_write(path, new_contents.as_bytes())?;
    Ok(())
}

/// Returns `true` when `contents` contains a full `<raum-managed>` block
/// (both the begin and end sentinel lines). Used by the scan path to
/// tell whether a Codex `config.toml` is currently raum-managed without
/// parsing the surrounding TOML.
#[must_use]
pub fn contains_managed_block(contents: &str) -> bool {
    split_around_block(contents).is_some()
}

/// Pure rendering step — exposed separately so tests can exercise every
/// branch without touching the filesystem.
#[must_use]
pub fn render(existing: Option<&str>, body: &str) -> String {
    let managed_block = format_block(body);
    let Some(existing) = existing else {
        // No file → block stands alone.
        return managed_block;
    };
    if let Some((before, after)) = split_around_block(existing) {
        // Replace.
        let mut out = String::with_capacity(before.len() + managed_block.len() + after.len());
        out.push_str(before);
        out.push_str(&managed_block);
        out.push_str(after);
        out
    } else {
        // Append with a leading blank line separator unless the file is
        // empty or already ends with one.
        let mut out = String::with_capacity(existing.len() + managed_block.len() + 2);
        out.push_str(existing);
        if !existing.is_empty() {
            if !existing.ends_with('\n') {
                out.push('\n');
            }
            if !existing.ends_with("\n\n") {
                out.push('\n');
            }
        }
        out.push_str(&managed_block);
        out
    }
}

fn format_block(body: &str) -> String {
    // Always terminate each line with `\n`; callers hand us a raw body
    // that may or may not be newline-terminated.
    let body_trimmed = body.trim_end_matches('\n');
    let mut out =
        String::with_capacity(body_trimmed.len() + BEGIN_MARKER.len() + END_MARKER.len() + 4);
    out.push_str(BEGIN_MARKER);
    out.push('\n');
    if !body_trimmed.is_empty() {
        out.push_str(body_trimmed);
        out.push('\n');
    }
    out.push_str(END_MARKER);
    out.push('\n');
    out
}

/// Split `contents` into the bytes before the begin marker line and the
/// bytes after the end marker line (both inclusive of any trailing
/// newline). Returns `None` when the markers are absent or unbalanced.
fn split_around_block(contents: &str) -> Option<(&str, &str)> {
    let begin_idx = find_marker_line_start(contents, BEGIN_MARKER)?;
    let after_begin = begin_idx + BEGIN_MARKER.len();
    let after_begin = slice_after_newline(contents, after_begin);
    // End marker must appear at or after `after_begin`.
    let search_region = contents.get(after_begin..)?;
    let end_rel = find_marker_line_start(search_region, END_MARKER)?;
    let end_idx = after_begin + end_rel;
    let after_end = end_idx + END_MARKER.len();
    let after_end = slice_after_newline(contents, after_end);
    let before = &contents[..begin_idx];
    let after = &contents[after_end..];
    Some((before, after))
}

/// Find the byte offset of a whole-line match of `marker` inside
/// `contents`. A "whole line" means either the start of the file or a
/// preceding newline, with no leading whitespace.
fn find_marker_line_start(contents: &str, marker: &str) -> Option<usize> {
    let mut search_from = 0;
    while let Some(rel) = contents[search_from..].find(marker) {
        let idx = search_from + rel;
        let at_line_start = idx == 0 || contents.as_bytes().get(idx - 1) == Some(&b'\n');
        // Marker must be followed by end-of-line or end-of-file (so
        // accidental substring matches like `# <raum-managed> ignored`
        // do not fool us).
        let after_marker = idx + marker.len();
        let trails_cleanly = matches!(
            contents.as_bytes().get(after_marker),
            None | Some(b'\n' | b'\r')
        );
        if at_line_start && trails_cleanly {
            return Some(idx);
        }
        search_from = idx + marker.len();
    }
    None
}

/// Advance past a `\n` (and an optional preceding `\r`) at `from`, if
/// present. If `from` is already at EOF, returns `from`.
fn slice_after_newline(contents: &str, from: usize) -> usize {
    let bytes = contents.as_bytes();
    let mut i = from;
    if bytes.get(i) == Some(&b'\r') {
        i += 1;
    }
    if bytes.get(i) == Some(&b'\n') {
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn creates_file_when_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        apply_managed_block(&path, "[features]\ncodex_hooks = true").unwrap();
        let got = std::fs::read_to_string(&path).unwrap();
        assert!(got.starts_with("# <raum-managed>\n"));
        assert!(got.contains("[features]\ncodex_hooks = true\n"));
        assert!(got.ends_with("# </raum-managed>\n"));
    }

    #[test]
    fn appends_to_existing_file_without_block() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "model = \"gpt-5\"\napprovals = \"on-request\"\n").unwrap();
        apply_managed_block(&path, "notify = [\"/bin/true\"]").unwrap();
        let got = std::fs::read_to_string(&path).unwrap();
        assert!(got.starts_with("model = \"gpt-5\"\napprovals = \"on-request\"\n"));
        assert!(got.contains("# <raum-managed>\nnotify = [\"/bin/true\"]\n# </raum-managed>"));
    }

    #[test]
    fn replaces_stale_block_in_place_preserving_neighbours() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let original = "\
model = \"gpt-5\"

# <raum-managed>
[features]
codex_hooks = false
# </raum-managed>

[mcp_servers.foo]
command = \"bar\"
";
        std::fs::write(&path, original).unwrap();
        apply_managed_block(
            &path,
            "[features]\ncodex_hooks = true\nnotify = [\"/bin/true\"]",
        )
        .unwrap();
        let got = std::fs::read_to_string(&path).unwrap();
        // Pre-block user content preserved byte-for-byte.
        assert!(got.starts_with("model = \"gpt-5\"\n\n"));
        // New managed block is present.
        assert!(got.contains(
            "# <raum-managed>\n[features]\ncodex_hooks = true\nnotify = [\"/bin/true\"]\n# </raum-managed>\n"
        ));
        // Trailing user content survived.
        assert!(got.contains("[mcp_servers.foo]\ncommand = \"bar\"\n"));
        // Stale body is gone.
        assert!(!got.contains("codex_hooks = false"));
    }

    #[test]
    fn idempotent_rerun() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let body = "[features]\ncodex_hooks = true\nnotify = [\"/bin/true\"]";
        apply_managed_block(&path, body).unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        apply_managed_block(&path, body).unwrap();
        let second = std::fs::read_to_string(&path).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn preserves_adjacent_user_lines_without_trailing_newline() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.toml");
        // File that does NOT end with a newline and has no managed block.
        std::fs::write(&path, "model = \"gpt-5\"").unwrap();
        apply_managed_block(&path, "notify = [\"/bin/true\"]").unwrap();
        let got = std::fs::read_to_string(&path).unwrap();
        // The original final line was preserved verbatim, then a blank
        // separator, then the block.
        assert!(got.starts_with("model = \"gpt-5\"\n"));
        assert!(got.contains("# <raum-managed>\nnotify = [\"/bin/true\"]\n# </raum-managed>"));
    }

    #[test]
    fn refuses_to_operate_on_unreadable_file() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = tempdir().unwrap();
            let path = dir.path().join("config.toml");
            std::fs::write(&path, "model = \"gpt-5\"\n").unwrap();
            // 0o000 → unreadable by anyone, even the owner on many kernels.
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
            // Operation must surface the underlying io error instead of
            // silently overwriting.
            let err = apply_managed_block(&path, "notify = [\"/bin/true\"]");
            // Best-effort restore so the tempdir drop can clean up.
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).ok();
            assert!(
                err.is_err(),
                "expected unreadable file to error, got ok: {:?}",
                std::fs::read_to_string(&path)
            );
        }
    }

    #[test]
    fn render_is_pure_and_deterministic() {
        let body = "notify = [\"/bin/true\"]";
        let a = render(None, body);
        let b = render(None, body);
        assert_eq!(a, b);
        assert!(a.ends_with("# </raum-managed>\n"));
    }

    #[test]
    fn split_around_block_handles_block_at_start() {
        let raw = "# <raum-managed>\nx = 1\n# </raum-managed>\nuser = 2\n";
        let (before, after) = split_around_block(raw).unwrap();
        assert_eq!(before, "");
        assert_eq!(after, "user = 2\n");
    }

    #[test]
    fn split_around_block_handles_block_at_end() {
        let raw = "user = 2\n# <raum-managed>\nx = 1\n# </raum-managed>\n";
        let (before, after) = split_around_block(raw).unwrap();
        assert_eq!(before, "user = 2\n");
        assert_eq!(after, "");
    }

    #[test]
    fn missing_markers_return_none() {
        assert!(split_around_block("foo = 1\n").is_none());
    }

    #[test]
    fn indented_markers_are_not_recognised() {
        // The sentinels must start at column 0 — an indented comment that
        // happens to contain "# <raum-managed>" must NOT be treated as
        // our sentinel.
        let raw = "  # <raum-managed>\n  x = 1\n  # </raum-managed>\n";
        assert!(split_around_block(raw).is_none());
    }
}
