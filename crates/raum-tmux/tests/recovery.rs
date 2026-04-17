//! §3.10 — integration test: spawn a session, drop the TmuxManager (simulating
//! an app exit), spawn a fresh TmuxManager on the same socket, assert the
//! session is still listed. Also exercises FIFO cleanup (§3.9).
//!
//! The test uses a *unique* socket name per run (pid + nanos suffix) so it
//! never clashes with the user's real `-L raum` socket or with a parallel test
//! worker. If `tmux` is missing from `$PATH`, the test is skipped with
//! `#[ignore]`-equivalent early return.

use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use raum_tmux::{TmuxManager, fifo_path_for, pipe_pane_to_fifo};

fn tmux_available() -> bool {
    Command::new("tmux")
        .arg("-V")
        .output()
        .is_ok_and(|o| o.status.success())
}

fn unique_socket() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("raum-test-{}-{}", std::process::id(), nanos)
}

#[tokio::test]
async fn recovers_session_across_manager_drops() {
    if !tmux_available() {
        eprintln!("recovery test: tmux not on PATH, skipping");
        return;
    }

    let socket = unique_socket();
    let session_id = format!("recov-{}", std::process::id());

    // Phase 1 — spawn manager A, create a session, write to it, then drop A.
    {
        let mgr = TmuxManager::with_socket(socket.clone());
        let cwd = PathBuf::from("/tmp");
        mgr.new_session(&session_id, &cwd, None, None)
            .expect("new-session");
        mgr.send_keys(&session_id, "echo raum-marker\n")
            .expect("send-keys");
        // Verify it's listed from A's perspective.
        let listed = mgr.list_sessions().expect("list-sessions (A)");
        assert!(
            listed.iter().any(|s| s.id == session_id),
            "session should be visible from the spawning manager"
        );
        drop(mgr);
    }

    // Phase 2 — fresh manager B on the same socket should see the session.
    let mgr_b = TmuxManager::with_socket(socket.clone());
    let listed = mgr_b.list_sessions().expect("list-sessions (B)");
    assert!(
        listed.iter().any(|s| s.id == session_id),
        "session survives manager drop: {listed:?}"
    );

    // Cleanup — kill the test session and the whole test server.
    let _ = mgr_b.kill_session(&session_id);
    let _ = mgr_b.kill_server();
}

#[tokio::test]
async fn fifo_removed_on_pipe_handle_drop() {
    if !tmux_available() {
        eprintln!("fifo cleanup test: tmux not on PATH, skipping");
        return;
    }

    let socket = unique_socket();
    let session_id = format!("fifo-{}", std::process::id());

    let mgr = TmuxManager::with_socket(socket.clone());
    let cwd = PathBuf::from("/tmp");
    mgr.new_session(&session_id, &cwd, None, None)
        .expect("new-session");

    let fifo_path = fifo_path_for(&session_id);
    let handle = pipe_pane_to_fifo(&mgr, &session_id, &fifo_path)
        .await
        .expect("pipe-pane");
    assert!(fifo_path.exists(), "fifo created under fifo_root");
    assert!(
        !fifo_path.starts_with(dirs_like_home_config()),
        "pane content MUST NOT be routed under ~/.config/raum (§3.9)"
    );

    drop(handle);
    // Drop is synchronous for the fifo unlink; the tail task abort is async but
    // cleanup of the fifo path happens in Drop directly.
    assert!(
        !fifo_path.exists(),
        "fifo path must be removed on PipePaneHandle drop"
    );

    let _ = mgr.kill_session(&session_id);
    let _ = mgr.kill_server();
}

fn dirs_like_home_config() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("raum");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".config").join("raum");
    }
    PathBuf::from("/nonexistent-raum-home")
}
