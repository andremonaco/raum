//! Integration test: spawn a session, drop the TmuxManager (simulating
//! an app exit), spawn a fresh TmuxManager on the same socket, assert the
//! session is still listed. Also exercises the PTY-attached client bridge
//! against a real tmux server.
//!
//! The test uses a *unique* socket name per run (pid + nanos suffix) so it
//! never clashes with the user's real `-L raum` socket or with a parallel test
//! worker. If `tmux` is missing from `$PATH`, the test is skipped early.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use raum_tmux::{TmuxManager, attach_via_pty};

fn tmux_available() -> bool {
    Command::new("tmux")
        .arg("-V")
        .output()
        .is_ok_and(|o| o.status.success())
}

/// Per-process socket counter. `SystemTime::now()` alone collides between
/// parallel test threads on fast macOS-arm64 runners (two threads can
/// observe the same nanosecond) — when that happened the threads shared a
/// tmux server and whichever finished first killed it out from under the
/// other, surfacing as `no server running` in capture-pane. Bumping a
/// monotonic counter here guarantees uniqueness even on a tie.
static SOCKET_SEQ: AtomicU64 = AtomicU64::new(0);

fn unique_socket() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let seq = SOCKET_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("raum-test-{}-{}-{}", std::process::id(), nanos, seq)
}

/// Bring up a tmux server on `socket` with the lifetime options
/// already pinned so there's never a moment where the defaults could
/// shut it down. Must be called *before* `new_session` — order
/// matters: setting `exit-empty off` after the server is empty doesn't
/// resurrect it, and setting it after a session exists in macOS-CI
/// `respawn-pane -k` flows still races the kill-then-exec window.
///
/// `start-server \; set-option …` runs both in a single tmux command
/// chain so the options are in effect before the first `new-session`
/// returns.
fn start_server_with_pinned_lifetime(socket: &str) {
    let out = Command::new("tmux")
        .args([
            "-L",
            socket,
            "start-server",
            ";",
            "set-option",
            "-s",
            "exit-empty",
            "off",
            ";",
            "set-option",
            "-s",
            "exit-unattached",
            "off",
        ])
        .output()
        .expect("spawn tmux start-server");
    assert!(
        out.status.success(),
        "tmux start-server + set-option failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[tokio::test]
async fn recovers_session_across_manager_drops() {
    if !tmux_available() {
        eprintln!("recovery test: tmux not on PATH, skipping");
        return;
    }

    let socket = unique_socket();
    let session_id = format!("recov-{}", std::process::id());

    // Phase 1 — spawn manager A, create a session, then drop A.
    {
        let mgr = TmuxManager::with_socket(socket.clone());
        let cwd = PathBuf::from("/tmp");
        mgr.new_session(&session_id, &cwd, None, None)
            .expect("new-session");
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pty_bridge_streams_attached_client_output() {
    if !tmux_available() {
        eprintln!("pty bridge test: tmux not on PATH, skipping");
        return;
    }

    let socket = unique_socket();
    let session_id = format!("pty-{}", std::process::id());

    let mgr = TmuxManager::with_socket(socket.clone());
    let cwd = PathBuf::from("/tmp");
    // Create the session detached. The PTY-attached client will render its
    // viewport once we attach below.
    mgr.new_session(&session_id, &cwd, None, Some((80, 24)))
        .expect("new-session");

    // Apply server options — matches what the host does at boot. Disabling
    // the prefix and dropping the status bar makes the rendered output
    // predictable.
    let _ = mgr.apply_server_options();

    let received: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let exited: Arc<Mutex<Option<i32>>> = Arc::new(Mutex::new(None));

    let received_for_sink = received.clone();
    let exited_for_sink = exited.clone();
    let bridge = attach_via_pty(
        &mgr,
        &session_id,
        80,
        24,
        Box::new(move |bytes| {
            received_for_sink.lock().unwrap().extend_from_slice(&bytes);
            true
        }),
        Box::new(move |code| {
            *exited_for_sink.lock().unwrap() = Some(code);
        }),
    )
    .expect("attach_via_pty");

    // Wait for the attached client to deliver any frame at all. tmux flushes
    // its initial repaint within a handful of milliseconds; budget 2 s on CI.
    let deadline = Instant::now() + Duration::from_secs(2);
    while received.lock().unwrap().is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        !received.lock().unwrap().is_empty(),
        "PTY bridge should deliver at least one frame from the attached tmux client"
    );

    // Killing the tmux session ends the attached client. The waiter thread
    // fires the exit sink; verify it lands within a generous budget.
    let _ = mgr.kill_session(&session_id);
    let deadline = Instant::now() + Duration::from_secs(2);
    while exited.lock().unwrap().is_none() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        exited.lock().unwrap().is_some(),
        "exit sink should fire once the attached tmux client exits"
    );

    drop(bridge);
    let _ = mgr.kill_server();
}

#[tokio::test]
async fn paste_into_pane_round_trips_payload_with_spaces_and_quotes() {
    if !tmux_available() {
        eprintln!("paste-into-pane test: tmux not on PATH, skipping");
        return;
    }

    let socket = unique_socket();
    let session_id = format!("paste-{}", std::process::id());
    let buffer_name = format!("raum-drop-test-{}", std::process::id());
    let tmp = std::env::temp_dir().join(format!("raum-paste-{}.txt", std::process::id()));
    let _ = std::fs::remove_file(&tmp);

    let mgr = TmuxManager::with_socket(socket.clone());
    // Run `cat` into a temp file so we can verify the bytes tmux injects hit
    // the pane exactly as delivered. `cat` does not enable bracketed paste,
    // so tmux will *not* wrap the payload in CSI 200/201 here — that's the
    // right behaviour: we're proving `paste_into_pane` delivers the raw
    // bytes when the inner app hasn't opted into bracketed paste.
    mgr.new_session(&session_id, &PathBuf::from("/tmp"), None, Some((80, 24)))
        .expect("new-session");
    mgr.respawn_with(&session_id, &format!("sh -lc 'cat > {}'", tmp.display()))
        .expect("respawn_with");

    // Give `cat` a moment to start reading stdin.
    tokio::time::sleep(Duration::from_millis(300)).await;

    let payload = b"/tmp/hello world.md /tmp/a'b.txt\n";
    mgr.paste_into_pane(&session_id, &buffer_name, payload, true)
        .expect("paste_into_pane");

    // Send Ctrl-D so `cat` flushes and exits, closing the file.
    let _ = Command::new("tmux")
        .args(["-L", &socket, "send-keys", "-t", &session_id, "C-d"])
        .output();

    // Wait for the file to materialise.
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut got = Vec::<u8>::new();
    while Instant::now() < deadline {
        if let Ok(bytes) = std::fs::read(&tmp) {
            if bytes.contains(&b'\n') {
                got = bytes;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // The payload should arrive verbatim — no backslash-escaping, no shell
    // quoting, spaces and single-quotes preserved.
    let got_str = String::from_utf8_lossy(&got);
    assert!(
        got_str.contains("/tmp/hello world.md /tmp/a'b.txt"),
        "pasted payload must round-trip verbatim, got: {got_str:?}"
    );

    let _ = std::fs::remove_file(&tmp);
    let _ = mgr.kill_session(&session_id);
    let _ = mgr.kill_server();
}

#[tokio::test]
async fn capture_pane_snapshot_returns_normal_buffer_with_crlf() {
    if !tmux_available() {
        eprintln!("capture-pane test: tmux not on PATH, skipping");
        return;
    }

    let socket = unique_socket();
    let session_id = format!("cap-{}", std::process::id());

    start_server_with_pinned_lifetime(&socket);
    let mgr = TmuxManager::with_socket(socket.clone());
    mgr.new_session(&session_id, &PathBuf::from("/tmp"), None, Some((80, 24)))
        .expect("new-session");
    mgr.respawn_with(
        &session_id,
        "sh -lc \"printf 'raum-capture-marker-0xFEED\\n'; sleep 5\"",
    )
    .expect("respawn_with");

    // Give the process a moment to execute and write output to the pane while
    // it is still alive.
    tokio::time::sleep(Duration::from_millis(300)).await;

    let snapshot = mgr
        .capture_pane_snapshot(&session_id)
        .expect("capture_pane_snapshot");
    let captured = snapshot.normal;

    // Non-empty — the shell ran something.
    assert!(
        !captured.is_empty(),
        "captured snapshot should include the echo output"
    );

    // The marker should be present in the captured bytes.
    let captured_str = String::from_utf8_lossy(&captured);
    assert!(
        captured_str.contains("raum-capture-marker-0xFEED"),
        "captured snapshot should contain the echo marker, got: {captured_str:?}"
    );

    // Line terminators must be CRLF (the method rewrites lone LF → CRLF so
    // xterm returns to column 0 on each line).
    assert!(
        captured.windows(2).any(|w| w == b"\r\n"),
        "captured history should use CRLF line endings"
    );
    assert!(
        !captured.windows(2).any(|w| w[0] != b'\r' && w[1] == b'\n'),
        "captured history must not contain bare LFs"
    );

    let _ = mgr.kill_session(&session_id);
    let _ = mgr.kill_server();
}

#[tokio::test]
async fn capture_pane_snapshot_separates_normal_history_from_live_alt_screen() {
    if !tmux_available() {
        eprintln!("alt-screen snapshot test: tmux not on PATH, skipping");
        return;
    }

    let socket = unique_socket();
    let session_id = format!("alt-{}", std::process::id());

    start_server_with_pinned_lifetime(&socket);
    let mgr = TmuxManager::with_socket(socket.clone());
    mgr.new_session(&session_id, &PathBuf::from("/tmp"), None, Some((80, 24)))
        .expect("new-session");
    // Re-pin after new_session: new_session_with_env sets `terminal-overrides`
    // via `set-option -s`, which on some macOS tmux builds resets server-level
    // defaults including exit-empty. Calling start_server_with_pinned_lifetime
    // again is idempotent (start-server is a no-op on a running server).
    start_server_with_pinned_lifetime(&socket);
    mgr.respawn_with(
        &session_id,
        // Use printf '\033[?1049h' (direct ANSI sequence) instead of `tput smcup`
        // to avoid login-shell profile side-effects and tput/terminfo failures on
        // macOS CI that caused `sh` to exit before `sleep 5`, collapsing the pane.
        "sh -c \"printf 'raum-main-marker\\n'; printf '\\033[?1049h'; printf 'raum-alt-marker\\n'; sleep 5\"",
    )
    .expect("respawn_with");

    tokio::time::sleep(Duration::from_millis(300)).await;

    let snapshot = mgr
        .capture_pane_snapshot(&session_id)
        .expect("capture_pane_snapshot");
    let normal = String::from_utf8_lossy(&snapshot.normal);
    let alternate = String::from_utf8_lossy(snapshot.alternate.as_deref().unwrap_or_default());

    assert!(
        normal.contains("raum-main-marker"),
        "normal snapshot should preserve pre-alt history, got {normal:?}"
    );
    assert!(
        !normal.contains("raum-alt-marker"),
        "normal snapshot must not be overwritten by the visible alt frame, got {normal:?}"
    );
    assert!(
        alternate.contains("raum-alt-marker"),
        "alternate snapshot should contain the visible alt frame, got {alternate:?}"
    );

    let _ = mgr.kill_session(&session_id);
    let _ = mgr.kill_server();
}

#[tokio::test]
async fn apply_server_options_strips_attached_client_alt_screen() {
    if !tmux_available() {
        eprintln!("server options test: tmux not on PATH, skipping");
        return;
    }

    let socket = unique_socket();
    let session_id = format!("opts-{}", std::process::id());

    let mgr = TmuxManager::with_socket(socket.clone());
    mgr.new_session(&session_id, &PathBuf::from("/tmp"), None, Some((80, 24)))
        .expect("new-session");
    mgr.apply_server_options().expect("apply_server_options");

    // `terminal-overrides` is a server option that governs the *attached*
    // client's capability set. Stripping smcup/rmcup for xterm-256color
    // keeps the attached `tmux attach-session` client out of xterm.js's
    // alternate buffer on connect, which is what makes xterm.js's 10k-line
    // normal-buffer scrollback usable for wheel scroll. The inner pane's
    // alt-screen behavior is driven by `alternate-screen` (a window
    // option) and the inner process's own TERM, and is not affected.
    let overrides = Command::new("tmux")
        .args(["-L", &socket, "show-options", "-sv", "terminal-overrides"])
        .output()
        .expect("tmux show-options terminal-overrides");
    let overrides_out = String::from_utf8_lossy(&overrides.stdout);
    assert!(
        overrides_out.contains("smcup@") && overrides_out.contains("rmcup@"),
        "server options must strip smcup/rmcup from the attached client's \
         terminfo so xterm.js scrollback is reachable, got {overrides_out:?}"
    );

    // The inner pane's alt-screen option must stay on so TUIs like Claude
    // Code get a real alt buffer within tmux.
    let alt_screen = Command::new("tmux")
        .args(["-L", &socket, "show-options", "-wgv", "alternate-screen"])
        .output()
        .expect("tmux show-options alternate-screen");
    let alt_out = String::from_utf8_lossy(&alt_screen.stdout);
    assert_ne!(
        alt_out.trim(),
        "off",
        "inner-pane alternate-screen must stay on, got {alt_out:?}"
    );

    let _ = mgr.kill_session(&session_id);
    let _ = mgr.kill_server();
}
