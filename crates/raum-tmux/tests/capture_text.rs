//! Integration test: `capture_pane_text` returns plain-text scrollback for
//! the global ⌘⇧F search. We spawn a session, pump a marker through the
//! shell, then assert the capture contains the marker with no ANSI escapes.

use std::path::PathBuf;
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use raum_tmux::TmuxManager;

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
    format!("raum-capture-{}-{}", std::process::id(), nanos)
}

#[tokio::test]
async fn capture_pane_text_returns_plain_scrollback() {
    if !tmux_available() {
        eprintln!("capture_pane_text test: tmux not on PATH, skipping");
        return;
    }

    let socket = unique_socket();
    let session_id = format!("cap-{}", std::process::id());
    let mgr = TmuxManager::with_socket(socket.clone());

    let cwd = PathBuf::from("/tmp");
    mgr.new_session(&session_id, &cwd, None, None)
        .expect("new-session");

    // Push a unique marker into the pane's history.
    mgr.send_command(&session_id, "printf 'RAUM_NEEDLE_MARKER\\n'")
        .expect("send-keys");

    // Give tmux a beat to ingest the output into its history buffer.
    let mut captured = String::new();
    for _ in 0..20 {
        sleep(Duration::from_millis(50));
        let snap = mgr
            .capture_pane_text(&session_id)
            .expect("capture_pane_text");
        captured = snap.normal;
        if captured.contains("RAUM_NEEDLE_MARKER") {
            assert!(snap.alternate.is_none(), "no TUI is running");
            // ANSI escape sequences start with ESC (0x1B); plain capture
            // must not include them.
            assert!(
                !captured.contains('\u{1b}'),
                "capture should not contain ANSI escapes: {captured:?}"
            );

            let _ = mgr.kill_session(&session_id);
            let _ = mgr.kill_server();
            return;
        }
    }

    let _ = mgr.kill_session(&session_id);
    let _ = mgr.kill_server();
    panic!("marker never appeared in tmux capture; last stdout:\n{captured}");
}
