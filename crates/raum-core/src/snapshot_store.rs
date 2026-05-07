//! Disk-backed terminal-snapshot store.
//!
//! Persists xterm.js `SerializeAddon`-encoded VT blobs per pane so raum can
//! restore inline-Claude / shell scrollback across restarts. The webview
//! cannot do this in localStorage — Tauri's WKWebView/WebView2 cap localStorage
//! at ~5 MiB per origin and macOS WebKit can purge it under the 7-day storage
//! policy — so the bytes round-trip through Tauri commands and land in
//! `state/terminal-snapshots/<session_id>.vtgz`.
//!
//! Bytes are written as-is; the frontend gzips before sending. We do not
//! interpret the VT stream here. `delete_for_session` clears a pane's
//! snapshot when the harness is killed; `gc_orphans` reaps any blobs whose
//! tmux session is no longer alive at startup.
//!
//! Atomic-write semantics: the same `path.<pid>.tmp` + `rename` pattern used
//! by `ConfigStore` so a crash mid-write never leaves a torn file.

use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::paths::terminal_snapshots_dir;

/// Test-only override for the snapshots directory. Production callers always
/// see `None` and fall back to [`terminal_snapshots_dir`]. Guarded by a Mutex
/// so concurrent test cases are serialized at the override boundary.
static DIR_OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);

fn snapshots_dir() -> PathBuf {
    DIR_OVERRIDE
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(terminal_snapshots_dir)
}

/// File extension for serialized snapshots. `.vtgz` because the frontend
/// gzip-compresses the SerializeAddon output before sending it down — saves
/// disk for full-color buffers without us needing to decompress to render.
const SNAPSHOT_EXT: &str = "vtgz";

/// Hard cap on a single snapshot file. SerializeAddon output for a 100k-line
/// full-color xterm buffer compresses to roughly 2–8 MiB; the 16 MiB ceiling
/// is twice the worst observed case so the frontend's
/// re-serialize-with-smaller-scrollback fallback fires only when something
/// pathological is going on (full-screen ASCII art for hours).
pub const SNAPSHOT_MAX_BYTES: usize = 16 * 1024 * 1024;

/// Sanitize a session id for use as a filename. raum's session ids are
/// already URL-safe (slug + hyphen + ulid) but we still defensively reject
/// anything containing `/`, `\`, `..`, or NUL so a buggy caller can't escape
/// the snapshots directory.
fn safe_filename(session_id: &str) -> Option<String> {
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains('\0')
        || session_id == "."
        || session_id == ".."
    {
        return None;
    }
    Some(format!("{session_id}.{SNAPSHOT_EXT}"))
}

fn snapshot_path(session_id: &str) -> Option<PathBuf> {
    let name = safe_filename(session_id)?;
    Some(snapshots_dir().join(name))
}

/// Persist a serialized snapshot for `session_id`. Returns `Ok(false)` when
/// the snapshot exceeds [`SNAPSHOT_MAX_BYTES`] (the caller should re-serialize
/// with a smaller scrollback). Atomic via tmpfile + rename on the same
/// filesystem; a crash mid-write leaves the previous snapshot intact.
pub fn persist(session_id: &str, bytes: &[u8]) -> io::Result<bool> {
    if bytes.len() > SNAPSHOT_MAX_BYTES {
        return Ok(false);
    }
    let Some(path) = snapshot_path(session_id) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid session id: {session_id:?}"),
        ));
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let pid = std::process::id();
    let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("snap");
    let tmp = path.with_file_name(format!(".{file_name}.{pid}.tmp"));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, &path)?;
    Ok(true)
}

/// Load a serialized snapshot. Returns `Ok(None)` when no snapshot exists
/// for the session.
pub fn load(session_id: &str) -> io::Result<Option<Vec<u8>>> {
    let Some(path) = snapshot_path(session_id) else {
        return Ok(None);
    };
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Remove a session's snapshot file. No-op when nothing exists. Called from
/// the pane death monitor and explicit kill paths so disk doesn't accumulate
/// snapshots for sessions the user has ended.
pub fn delete_for_session(session_id: &str) -> io::Result<()> {
    let Some(path) = snapshot_path(session_id) else {
        return Ok(());
    };
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Reap snapshot files whose session ids are not in `live_session_ids`.
/// Called once at raum startup against the live tmux session list so blobs
/// from sessions killed while raum was down do not linger.
///
/// Returns the number of files removed.
pub fn gc_orphans<S: AsRef<str>>(live_session_ids: &[S]) -> io::Result<usize> {
    let dir = snapshots_dir();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let live: std::collections::HashSet<&str> =
        live_session_ids.iter().map(AsRef::as_ref).collect();
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        // Skip stray tmp files left behind by an interrupted atomic write
        // — they'll either be overwritten by the next persist or cleaned
        // by the OS on its next sweep. Don't deletion-loop them here.
        let Some(stem) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(&format!(".{SNAPSHOT_EXT}")))
        else {
            continue;
        };
        if !live.contains(stem) {
            if let Err(e) = fs::remove_file(&path) {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "snapshot_store::gc_orphans: failed to remove orphan",
                );
            } else {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    // `DIR_OVERRIDE` serializes us implicitly across concurrent tests in this
    // module, but a parent guard makes the intent explicit and ensures we
    // always restore the previous override on panic.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_dir<F: FnOnce(&std::path::Path)>(f: F) {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let tmp = tempfile::tempdir().expect("tempdir");
        {
            let mut g = DIR_OVERRIDE.lock().expect("override lock");
            *g = Some(tmp.path().to_path_buf());
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(tmp.path())));
        {
            let mut g = DIR_OVERRIDE.lock().expect("override lock");
            *g = None;
        }
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
    }

    #[test]
    fn round_trip_preserves_bytes() {
        with_temp_dir(|_| {
            let bytes = b"\x1b[2J\x1b[Hhello world\r\n".to_vec();
            persist("sess-abc", &bytes).expect("persist");
            let loaded = load("sess-abc").expect("load");
            assert_eq!(loaded.as_deref(), Some(bytes.as_slice()));
        });
    }

    #[test]
    fn load_missing_returns_none() {
        with_temp_dir(|_| {
            assert!(load("sess-missing").expect("load").is_none());
        });
    }

    #[test]
    fn delete_idempotent() {
        with_temp_dir(|_| {
            persist("sess-x", b"hello").expect("persist");
            delete_for_session("sess-x").expect("delete 1");
            delete_for_session("sess-x").expect("delete 2 should be no-op");
            assert!(load("sess-x").expect("load").is_none());
        });
    }

    #[test]
    fn over_cap_returns_false() {
        with_temp_dir(|_| {
            let too_big = vec![b'x'; SNAPSHOT_MAX_BYTES + 1];
            let persisted = persist("sess-big", &too_big).expect("persist");
            assert!(!persisted, "over-cap snapshot should be rejected");
            assert!(
                load("sess-big").expect("load").is_none(),
                "no file should have been created when rejected",
            );
        });
    }

    #[test]
    fn unsafe_session_ids_rejected() {
        with_temp_dir(|_| {
            for bad in &["", "..", ".", "a/b", r"a\b", "a\0b"] {
                let result = persist(bad, b"x");
                assert!(
                    result.is_err(),
                    "expected persist to reject unsafe id {bad:?}"
                );
            }
        });
    }

    #[test]
    fn gc_orphans_removes_dead_sessions_only() {
        with_temp_dir(|_| {
            persist("sess-alive", b"alive").expect("persist alive");
            persist("sess-dead-1", b"dead1").expect("persist dead1");
            persist("sess-dead-2", b"dead2").expect("persist dead2");

            let live = ["sess-alive".to_string()];
            let removed = gc_orphans(&live).expect("gc");
            assert_eq!(removed, 2);

            assert!(load("sess-alive").expect("load alive").is_some());
            assert!(load("sess-dead-1").expect("load dead1").is_none());
            assert!(load("sess-dead-2").expect("load dead2").is_none());
        });
    }

    #[test]
    fn gc_orphans_handles_missing_dir() {
        with_temp_dir(|_| {
            // No snapshots written → directory does not exist. Should not error.
            let removed = gc_orphans::<String>(&[]).expect("gc on missing dir");
            assert_eq!(removed, 0);
        });
    }
}
