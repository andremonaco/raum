//! Persist `AgentStateChanged` / `PromptUpdated` records to the config store
//! and seed in-memory activity / hook-fallback state.

use std::path::PathBuf;

use raum_core::agent::AgentKind;
use raum_core::agent_state::{AgentStateChanged, PromptUpdated};
use raum_core::harness::setup::SetupContext;
use raum_core::paths;
use tauri::{AppHandle, Manager, Runtime};
use tracing::warn;

use crate::state::{AppHandleState, SessionActivity};

/// Rewrite `state/sessions.toml` with the session's new state.
///
/// `async` + `spawn_blocking`: the caller is the bridge task on the async
/// runtime, and this does a read-modify-write of the whole TOML while holding
/// the std `config_store` mutex — blocking work that must not run on a runtime
/// worker. Awaiting keeps the caller's "persist before emit" ordering intact.
///
/// The store coalesces the disk half of this into one atomic write per 500 ms
/// quiet window (`ConfigStore::write_sessions_debounced`) once the row exists;
/// the in-memory cache every reader goes through is still updated inline, so
/// the ordering guarantee is unaffected.
pub(super) async fn persist_last_state<R: Runtime>(app: &AppHandle<R>, change: &AgentStateChanged) {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    let app = app.clone();
    let session_id = change.session_id.as_str().to_string();
    let harness = change.harness;
    let to = change.to;
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let state: tauri::State<'_, AppHandleState> = app.state();
        let store = match state.config_store.lock() {
            Ok(g) => g,
            Err(_) => {
                warn!("persist last_state: config_store lock poisoned");
                return;
            }
        };
        if let Err(e) = store.update_session_last_state(&session_id, harness, to, now_ms) {
            warn!(error=%e, session_id=%session_id, "persist last_state failed");
        }
    })
    .await;
    if let Err(e) = joined {
        warn!(error=%e, "persist last_state: blocking task failed");
    }
}

/// Same blocking-IO reasoning as [`persist_last_state`].
pub(super) async fn persist_last_prompt<R: Runtime>(app: &AppHandle<R>, update: &PromptUpdated) {
    let app = app.clone();
    let session_id = update.session_id.as_str().to_string();
    let text = update.text.clone();
    let submitted_at_ms = update.submitted_at_ms;
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let state: tauri::State<'_, AppHandleState> = app.state();
        let store = match state.config_store.lock() {
            Ok(g) => g,
            Err(_) => {
                warn!("persist last_prompt: config_store lock poisoned");
                return;
            }
        };
        if let Err(e) = store.update_session_last_prompt(&session_id, &text, submitted_at_ms) {
            warn!(error=%e, session_id=%session_id, "persist last_prompt failed");
        }
        // Cross-harness review reads prompts directly from each harness's own
        // on-disk transcript (see `crates/raum-core/src/review/transcript.rs`)
        // — raum no longer maintains its own append-only prompt log.
    })
    .await;
    if let Err(e) = joined {
        warn!(error=%e, "persist last_prompt: blocking task failed");
    }
}

pub(super) fn seed_session_activity_for_persisted_state(
    session_activity: &SessionActivity,
    session_id: &str,
    persisted_state: Option<raum_core::agent::AgentState>,
) {
    if persisted_state == Some(raum_core::agent::AgentState::Working) {
        // Reattached sessions can be seeded from the last persisted state
        // before any fresh PTY bytes arrive. Seed a synthetic "last output"
        // timestamp so the silence tick can age a stale Working seed back to
        // Idle instead of leaving it stuck forever on cold boot.
        session_activity.touch(session_id);
    }
}

pub fn infer_reattach_hook_fallback(
    state: &AppHandleState,
    harness: AgentKind,
    project_slug: Option<&str>,
    project_dir: PathBuf,
) -> bool {
    let event_path_available = state
        .channel_event_tx
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .is_some();
    if !event_path_available {
        return true;
    }
    if !matches!(harness, AgentKind::ClaudeCode | AgentKind::Codex) {
        return false;
    }

    let home_dir = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    let ctx = SetupContext::new(
        paths::hooks_dir(),
        paths::event_socket_path(),
        project_slug.unwrap_or_default().to_string(),
    )
    .with_project_dir(project_dir)
    .with_home_dir(home_dir);
    !state
        .harness_runtimes
        .scan(harness, &ctx)
        .raum_hooks_installed
}
