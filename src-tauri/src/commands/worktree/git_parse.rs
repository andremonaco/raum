//! Pure parsers for git plumbing output. Everything here operates on raw
//! bytes from `-z` (NUL-terminated) invocations so paths with spaces,
//! newlines, or non-UTF8 bytes never hit the quoting ambiguities of the
//! line-oriented formats (`core.quotePath` mangles non-ASCII paths there).
//! No `Command` is spawned in this module — every function is unit-testable
//! against byte fixtures (see `worktree/tests.rs`).

use std::collections::HashMap;

use super::types::{FileChange, FileChangeKind, WorktreeStatus};

/// Hard cap on per-file entries returned across the IPC boundary. A repo with
/// tens of thousands of changed files (fresh `node_modules` checked in by
/// accident, generated trees) would otherwise serialize megabytes into the
/// webview on every status push. `dirty` and the insertion/deletion totals
/// are computed *before* the cap so the header badges stay truthful.
pub(super) const MAX_FILE_CHANGES: usize = 1000;

/// Result of parsing `git status --porcelain=v2 --branch -z`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(super) struct PorcelainStatus {
    pub changes: Vec<FileChange>,
    /// Current branch name; `None` in detached-HEAD state.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

/// Map a porcelain v2 `X`/`Y` status character to a [`FileChangeKind`].
/// Unknown characters fall back to `Modified` so a future git version can
/// never make a changed file disappear from the sidebar.
fn kind_for(c: char) -> FileChangeKind {
    match c {
        'A' => FileChangeKind::Added,
        'D' => FileChangeKind::Deleted,
        'T' => FileChangeKind::TypeChange,
        'R' | 'C' => FileChangeKind::Renamed,
        'U' => FileChangeKind::Conflicted,
        _ => FileChangeKind::Modified,
    }
}

fn change(path: &str, kind: FileChangeKind, staged: bool, orig_path: Option<&str>) -> FileChange {
    FileChange {
        path: path.to_string(),
        orig_path: orig_path.map(str::to_string),
        kind,
        staged,
        insertions: None,
        deletions: None,
    }
}

/// Parse `git status --porcelain=v2 --branch --untracked-files=all -z`.
///
/// Tokens are NUL-separated. Within a token, fields are space-separated and
/// the path is the final field (paths may contain spaces — we `splitn` with
/// the exact field count per record type so the remainder is the verbatim
/// path). Rename records (`2`) are followed by one extra NUL token carrying
/// the original path.
///
/// Per-record emission:
/// * `1 XY …` — X ≠ `.` emits a staged entry, Y ≠ `.` emits an unstaged
///   entry; `MM` therefore yields **two** entries, matching the sidebar's
///   Staged/Unstaged buckets.
/// * `2 XY … <path>` + `<orig>` — same X/Y split; both entries carry
///   `orig_path` so the UI can render `old → new`.
/// * `u XY …` — one unstaged `Conflicted` entry.
/// * `? <path>` — one unstaged `Untracked` entry.
/// * `! <path>` — ignored (we never pass `--ignored`).
pub(super) fn parse_porcelain_v2_z(bytes: &[u8]) -> PorcelainStatus {
    let mut out = PorcelainStatus::default();
    let mut tokens = bytes
        .split(|b| *b == 0)
        .map(|t| String::from_utf8_lossy(t).into_owned());

    while let Some(tok) = tokens.next() {
        if tok.is_empty() {
            continue;
        }
        if let Some(rest) = tok.strip_prefix("# branch.head ") {
            if rest != "(detached)" {
                out.branch = Some(rest.to_string());
            }
        } else if let Some(rest) = tok.strip_prefix("# branch.upstream ") {
            if !rest.is_empty() {
                out.upstream = Some(rest.to_string());
            }
        } else if let Some(rest) = tok.strip_prefix("# branch.ab ") {
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+').and_then(|n| n.parse().ok()) {
                    out.ahead = n;
                } else if let Some(n) = part.strip_prefix('-').and_then(|n| n.parse().ok()) {
                    out.behind = n;
                }
            }
        } else if let Some(rest) = tok.strip_prefix("1 ") {
            // "XY sub mH mI mW hH hI <path>" — 7 fields before the path.
            let mut parts = rest.splitn(8, ' ');
            let xy = parts.next().unwrap_or("..");
            let Some(path) = parts.nth(6) else { continue };
            push_xy_entries(&mut out.changes, xy, path, None);
        } else if let Some(rest) = tok.strip_prefix("2 ") {
            // "XY sub mH mI mW hH hI X<score> <path>" — 8 fields before the
            // path; the original path arrives as the next NUL token.
            let orig = tokens.next();
            let mut parts = rest.splitn(9, ' ');
            let xy = parts.next().unwrap_or("..");
            let Some(path) = parts.nth(7) else { continue };
            push_xy_entries(&mut out.changes, xy, path, orig.as_deref());
        } else if let Some(rest) = tok.strip_prefix("u ") {
            // "XY sub m1 m2 m3 mW h1 h2 h3 <path>" — 9 fields before the path.
            let Some(path) = rest.splitn(10, ' ').nth(9) else {
                continue;
            };
            out.changes
                .push(change(path, FileChangeKind::Conflicted, false, None));
        } else if let Some(path) = tok.strip_prefix("? ") {
            out.changes
                .push(change(path, FileChangeKind::Untracked, false, None));
        }
    }
    out
}

fn push_xy_entries(changes: &mut Vec<FileChange>, xy: &str, path: &str, orig: Option<&str>) {
    let index_char = xy.chars().next().unwrap_or('.');
    let worktree_char = xy.chars().nth(1).unwrap_or('.');
    if index_char != '.' {
        changes.push(change(path, kind_for(index_char), true, orig));
    }
    if worktree_char != '.' {
        changes.push(change(path, kind_for(worktree_char), false, orig));
    }
}

/// Parse `git diff --numstat -z -M HEAD` into `path → (insertions, deletions)`.
///
/// Record shape: `ins TAB del TAB path NUL`. Binary files report `-` in
/// either column → `None`. Renames leave the path field empty and append two
/// extra NUL tokens (`old`, `new`) — we key by the *new* path, matching the
/// porcelain entry's `path`.
pub(super) fn parse_numstat_z(bytes: &[u8]) -> HashMap<String, (Option<u32>, Option<u32>)> {
    let mut map = HashMap::new();
    let mut tokens = bytes.split(|b| *b == 0);
    while let Some(tok) = tokens.next() {
        if tok.is_empty() {
            continue;
        }
        let s = String::from_utf8_lossy(tok);
        let mut fields = s.splitn(3, '\t');
        let (Some(ins), Some(del), Some(path)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let counts = (ins.parse().ok(), del.parse().ok());
        if path.is_empty() {
            // Rename: the next two tokens are old + new path.
            let _old = tokens.next();
            let Some(new) = tokens.next() else { break };
            map.insert(String::from_utf8_lossy(new).into_owned(), counts);
        } else {
            map.insert(path.to_string(), counts);
        }
    }
    map
}

/// Sum a numstat map into `(insertions, deletions)` totals — the replacement
/// for the separate `git diff --shortstat HEAD` subprocess.
pub(super) fn numstat_totals(map: &HashMap<String, (Option<u32>, Option<u32>)>) -> (u32, u32) {
    map.values().fold((0, 0), |(ins, del), (i, d)| {
        (ins + i.unwrap_or(0), del + d.unwrap_or(0))
    })
}

/// Attach per-file `+/-` counts to status entries. Both the staged and the
/// unstaged entry of a path receive the same vs-HEAD counts (splitting them
/// per stage would need a second `--cached` numstat run — not worth a third
/// subprocess for a display hint). Untracked files never appear in
/// `diff HEAD`, so they keep `None`.
pub(super) fn apply_numstat(
    changes: &mut [FileChange],
    counts: &HashMap<String, (Option<u32>, Option<u32>)>,
) {
    for c in changes {
        if let Some((ins, del)) = counts.get(&c.path) {
            c.insertions = *ins;
            c.deletions = *del;
        }
    }
}

/// Assemble the final [`WorktreeStatus`] from the two parses: merge counts,
/// compute `dirty` + totals (pre-cap), then cap the entry list with untracked
/// files sorted last so tracked changes survive truncation.
pub(super) fn assemble_status(
    porcelain: PorcelainStatus,
    numstat: &HashMap<String, (Option<u32>, Option<u32>)>,
    stash_count: u32,
) -> WorktreeStatus {
    let PorcelainStatus {
        mut changes,
        upstream,
        ahead,
        behind,
        ..
    } = porcelain;
    apply_numstat(&mut changes, numstat);
    let (insertions, deletions) = numstat_totals(numstat);
    let dirty = !changes.is_empty();
    let truncated = changes.len() > MAX_FILE_CHANGES;
    if truncated {
        // Stable: keeps git's order within each partition.
        changes.sort_by_key(|c| c.kind == FileChangeKind::Untracked);
        changes.truncate(MAX_FILE_CHANGES);
    }
    WorktreeStatus {
        dirty,
        changes,
        truncated,
        insertions,
        deletions,
        upstream,
        ahead,
        behind,
        stash_count,
    }
}

/// One commit from `git log -z --format=%H%x00%h%x00%an%x00%at%x00%s`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RawCommit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub timestamp: i64,
    pub subject: String,
}

/// Parse the flat NUL-token stream of the log format above: with `-z` the
/// inter-commit terminator is also NUL, so the stream is chunks of exactly
/// five tokens (`%s` can never contain NUL or newline; `%an` can never
/// contain NUL). One trailing empty token (after the final terminator) is
/// dropped before chunking — empty *subjects* are interior tokens and
/// survive.
pub(super) fn parse_log_z(bytes: &[u8]) -> Vec<RawCommit> {
    let mut tokens: Vec<String> = bytes
        .split(|b| *b == 0)
        .map(|t| String::from_utf8_lossy(t).into_owned())
        .collect();
    if tokens.last().is_some_and(String::is_empty) {
        tokens.pop();
    }
    tokens
        .chunks_exact(5)
        .map(|c| RawCommit {
            hash: c[0].clone(),
            short_hash: c[1].clone(),
            author: c[2].clone(),
            timestamp: c[3].parse().unwrap_or(0),
            subject: c[4].clone(),
        })
        .collect()
}

/// Parse `git show/diff --name-status -z` output: `letter NUL path NUL`, with
/// rename/copy records (`R<score>`/`C<score>`) consuming a second path token
/// (`old NUL new NUL`). Returns `(kind, path, orig_path)` tuples in git
/// order.
pub(super) fn parse_name_status_z(bytes: &[u8]) -> Vec<(FileChangeKind, String, Option<String>)> {
    let mut out = Vec::new();
    let mut tokens = bytes
        .split(|b| *b == 0)
        .map(|t| String::from_utf8_lossy(t).into_owned());
    while let Some(status) = tokens.next() {
        if status.is_empty() {
            continue;
        }
        let letter = status.chars().next().unwrap_or('M');
        let Some(path) = tokens.next() else { break };
        if matches!(letter, 'R' | 'C') {
            let Some(new) = tokens.next() else { break };
            out.push((FileChangeKind::Renamed, new, Some(path)));
        } else {
            out.push((kind_for(letter), path, None));
        }
    }
    out
}
