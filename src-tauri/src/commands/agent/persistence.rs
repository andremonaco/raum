//! Persist `AgentStateChanged` / `PromptUpdated` records to the config store
//! and seed in-memory activity / hook-fallback state.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use raum_core::agent::AgentKind;
use raum_core::agent_state::{AgentStateChanged, PromptUpdated};
use raum_core::harness::setup::SetupContext;
use raum_core::paths;
use tauri::{AppHandle, Manager, Runtime};
use tracing::warn;

use crate::state::AppHandleState;

pub(super) fn persist_last_state<R: Runtime>(app: &AppHandle<R>, change: &AgentStateChanged) {
    let state: tauri::State<'_, AppHandleState> = app.state();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    let store = match state.config_store.lock() {
        Ok(g) => g,
        Err(_) => {
            warn!("persist last_state: config_store lock poisoned");
            return;
        }
    };
    if let Err(e) = store.update_session_last_state(
        change.session_id.as_str(),
        change.harness,
        change.to,
        now_ms,
    ) {
        warn!(error=%e, session_id=%change.session_id.as_str(), "persist last_state failed");
    }
}

pub(super) fn persist_last_prompt<R: Runtime>(app: &AppHandle<R>, update: &PromptUpdated) {
    let state: tauri::State<'_, AppHandleState> = app.state();
    let store = match state.config_store.lock() {
        Ok(g) => g,
        Err(_) => {
            warn!("persist last_prompt: config_store lock poisoned");
            return;
        }
    };
    if let Err(e) = store.update_session_last_prompt(
        update.session_id.as_str(),
        &update.text,
        update.submitted_at_ms,
    ) {
        warn!(error=%e, session_id=%update.session_id.as_str(), "persist last_prompt failed");
    }
    // Cross-harness review reads prompts directly from each harness's own
    // on-disk transcript (see `crates/raum-core/src/review/transcript.rs`)
    // — raum no longer maintains its own append-only prompt log.
}

pub(super) fn seed_session_activity_for_persisted_state(
    session_activity: &Arc<Mutex<HashMap<String, Instant>>>,
    session_id: &str,
    persisted_state: Option<raum_core::agent::AgentState>,
) {
    let Ok(mut activity) = session_activity.lock() else {
        warn!(
            session_id = %session_id,
            "seed persisted state: session_activity lock poisoned"
        );
        return;
    };
    if persisted_state == Some(raum_core::agent::AgentState::Working) {
        // Reattached sessions can be seeded from the last persisted state
        // before any fresh PTY bytes arrive. Seed a synthetic "last output"
        // timestamp so the silence tick can age a stale Working seed back to
        // Idle instead of leaving it stuck forever on cold boot.
        activity.insert(session_id.to_string(), Instant::now());
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
