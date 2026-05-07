//! Hook-pipeline diagnostics + selftest commands surfaced by the Harness
//! Health panel.

use std::path::PathBuf;
use std::time::Duration;

use raum_core::agent::AgentKind;
use raum_core::harness::setup::SetupContext;
use raum_core::paths;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tracing::warn;

use super::helpers::resolve_project_dir;
use crate::state::AppHandleState;

/// Snapshot of the hook-event pipeline health. Consumed by the Harness
/// Health panel in the settings modal to surface whether the UDS
/// socket bound successfully and whether any hook has ever fired.
///
/// Answers the common "why isn't the busy indicator moving?" question
/// without asking the user to read logs. In dev builds the hook
/// dispatcher script silently exits on transport failures; the
/// `scripts_written` + `transports_available` + `env_raum_event_sock`
/// triad lets the UI spot each common failure mode (no socat / missing
/// script / env var never exported / harness started before config
/// install).
#[derive(Debug, Serialize)]
pub struct HooksDiagnostics {
    pub socket_bound: bool,
    pub socket_path: Option<String>,
    pub last_hook_at_unix: Option<u64>,
    pub last_hook_harness: Option<String>,
    pub last_hook_event: Option<String>,
    /// `RAUM_EVENT_SOCK` value as currently exported to raum's
    /// environment. Child harnesses inherit this via tmux `-e`; if it's
    /// `None`, every subsequent harness spawn will fall back to the
    /// silence heuristic because the scripts early-exit on empty
    /// `$RAUM_EVENT_SOCK`.
    pub env_raum_event_sock: Option<String>,
    /// Per-script disposition: does the dispatcher exist, is it
    /// executable (mode 0700), and can the runtime resolve at least
    /// one transport (`socat` / `nc` / `python3`)? Empty list when the
    /// hooks dir hasn't been populated yet.
    pub scripts_written: Vec<HookScriptStatus>,
    /// Runtime transports the hook dispatcher scripts fall back onto
    /// in the `socat → nc → python3` order. A script with **none**
    /// available silently exits 0 on every hook invocation and is the
    /// canonical "why aren't hooks firing in dev?" failure mode on
    /// hosts that don't ship one of the three.
    pub transports_available: TransportProbe,
}

/// Per-harness script status surfaced to the Harness Health panel.
#[derive(Debug, Serialize)]
pub struct HookScriptStatus {
    pub harness: String,
    pub path: String,
    pub exists: bool,
    /// POSIX mode bits of the script file (e.g. `0o700`). `None` when
    /// the file is missing.
    pub mode: Option<u32>,
    /// `true` iff `mode & 0o100 == 0o100` — the owner-exec bit is set.
    pub executable: bool,
}

/// Availability of the three transports the hook dispatcher script
/// falls back through. `any()` returning false means the script will
/// silently exit 0 on every invocation.
#[derive(Debug, Serialize, Default)]
pub struct TransportProbe {
    pub socat: bool,
    pub nc: bool,
    pub python3: bool,
}

impl TransportProbe {
    #[must_use]
    pub fn probe() -> Self {
        Self {
            socat: which::which("socat").is_ok(),
            nc: which::which("nc").is_ok(),
            python3: which::which("python3").is_ok(),
        }
    }
}

fn script_status(harness: &str, hooks_dir: &std::path::Path) -> HookScriptStatus {
    let path = hooks_dir.join(format!("{harness}.sh"));
    let meta = std::fs::metadata(&path).ok();
    let exists = meta.is_some();
    let mode = meta.as_ref().map(|m| {
        use std::os::unix::fs::PermissionsExt;
        m.permissions().mode() & 0o777
    });
    let executable = mode.is_some_and(|m| m & 0o100 == 0o100);
    HookScriptStatus {
        harness: harness.to_string(),
        path: path.to_string_lossy().into_owned(),
        exists,
        mode,
        executable,
    }
}

#[tauri::command]
pub fn hooks_diagnostics(state: tauri::State<'_, AppHandleState>) -> HooksDiagnostics {
    let (socket_bound, socket_path) = match state.event_socket.lock() {
        Ok(g) => match g.as_ref() {
            Some(h) => (true, Some(h.path.to_string_lossy().into_owned())),
            None => (false, None),
        },
        Err(_) => (false, None),
    };
    let (last_hook_at_unix, last_hook_harness, last_hook_event) = match state.last_hook_at.lock() {
        Ok(g) => match g.as_ref() {
            Some(lh) => (
                Some(lh.at_unix),
                Some(lh.harness.clone()),
                Some(lh.event.clone()),
            ),
            None => (None, None, None),
        },
        Err(_) => (None, None, None),
    };
    let env_raum_event_sock = std::env::var(raum_hooks::RAUM_EVENT_SOCK_ENV).ok();
    let hooks_dir = paths::hooks_dir();
    let scripts_written = vec![
        script_status("claude-code", &hooks_dir),
        script_status("codex", &hooks_dir),
        script_status("codex-notify", &hooks_dir),
    ];
    let transports_available = TransportProbe::probe();
    HooksDiagnostics {
        socket_bound,
        socket_path,
        last_hook_at_unix,
        last_hook_harness,
        last_hook_event,
        env_raum_event_sock,
        scripts_written,
        transports_available,
    }
}

/// Synthetic round-trip test for the hook-event UDS pipeline.
///
/// Writes a sentinel `HookEvent` to the bound socket and waits up to
/// 2 s for the `last_hook_at` timestamp in [`AppHandleState`] to update
/// past the pre-call snapshot. Returns whether the round-trip
/// succeeded plus enough detail for the UI to render a one-line result.
///
/// This is the surface the Harness Health "Run selftest" button pokes —
/// it proves the socket is bound AND the drain task is running, without
/// requiring the user to install a harness first.
#[derive(Debug, Serialize)]
pub struct HooksSelftestReport {
    pub ok: bool,
    pub detail: String,
    pub elapsed_ms: u64,
    pub socket_path: Option<String>,
    pub transport_used: Option<String>,
}

#[tauri::command]
pub async fn hooks_selftest<R: Runtime>(app: AppHandle<R>) -> Result<HooksSelftestReport, String> {
    use std::time::Instant;
    use tokio::io::AsyncWriteExt;
    use tokio::net::UnixStream;

    let started = Instant::now();
    let state: tauri::State<'_, AppHandleState> = app.state();
    let socket_path: Option<std::path::PathBuf> = state
        .event_socket
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|h| h.path.clone()));
    let Some(path) = socket_path else {
        return Ok(HooksSelftestReport {
            ok: false,
            detail: "event socket is not bound".into(),
            elapsed_ms: elapsed_ms(started),
            socket_path: None,
            transport_used: None,
        });
    };
    let path_display = path.to_string_lossy().into_owned();

    // Snapshot the pre-write timestamp so we can detect the synthetic
    // event landing without relying on wall-clock comparisons that
    // could fold into an already-recent timestamp.
    let before: Option<u64> = state
        .last_hook_at
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|lh| lh.at_unix));

    // Tag the synthetic event distinctly so the drain loop's warn/log
    // surfaces identify it, and any classification logic can ignore it.
    let payload = serde_json::json!({
        "harness": "shell",
        "event": "raum-selftest",
        "session_id": null,
        "source": "hooks_selftest",
        "reliability": "deterministic",
        "payload": { "selftest": true },
    });
    let mut line = payload.to_string();
    line.push('\n');

    let send_result = async {
        let mut stream = UnixStream::connect(&path).await?;
        stream.write_all(line.as_bytes()).await?;
        stream.flush().await?;
        Ok::<(), std::io::Error>(())
    }
    .await;

    if let Err(e) = send_result {
        return Ok(HooksSelftestReport {
            ok: false,
            detail: format!("connect/write failed: {e}"),
            elapsed_ms: elapsed_ms(started),
            socket_path: Some(path_display),
            transport_used: Some("tokio::UnixStream".into()),
        });
    }

    // Poll the diagnostic timestamp for up to 2 s.
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        let observed: Option<u64> = state
            .last_hook_at
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|lh| lh.at_unix));
        if observed.is_some() && observed != before {
            return Ok(HooksSelftestReport {
                ok: true,
                detail: "round-trip ok".into(),
                elapsed_ms: elapsed_ms(started),
                socket_path: Some(path_display),
                transport_used: Some("tokio::UnixStream".into()),
            });
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    Ok(HooksSelftestReport {
        ok: false,
        detail: "event written but drain never observed it (drain stalled?)".into(),
        elapsed_ms: elapsed_ms(started),
        socket_path: Some(path_display),
        transport_used: Some("tokio::UnixStream".into()),
    })
}

fn elapsed_ms(start: std::time::Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Phase 6 — Tauri command that runs the harness selftest on demand
/// (bound to the "Run again" button in the Harness Health panel).
/// Emits `harness-selftest-report` with the result so the frontend
/// store subscribes once rather than juggling response values.
#[tauri::command]
pub async fn harness_selftest<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppHandleState>,
    harness: AgentKind,
    project_slug: Option<String>,
    worktree_id: Option<String>,
) -> Result<raum_core::harness::SelftestReport, String> {
    let slug = project_slug.unwrap_or_default();
    let project_dir = resolve_project_dir(&state, Some(&slug), worktree_id.as_deref());
    let home_dir = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    let ctx = SetupContext::new(paths::hooks_dir(), paths::event_socket_path(), slug)
        .with_project_dir(project_dir)
        .with_home_dir(home_dir);
    let report = state.harness_runtimes.selftest(harness, &ctx).await;
    if let Err(e) = app.emit("harness-selftest-report", &report) {
        warn!(error=%e, "harness-selftest-report emit failed");
    }
    Ok(report)
}
