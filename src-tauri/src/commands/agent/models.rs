//! `list_harness_models` — discover available models for a harness so the
//! cross-review picker can show real choices instead of a hardcoded table.
//!
//! Discovery is non-trivial (Codex parses a JSON cache, OpenCode shells out)
//! so results are cached per-kind for 30 seconds on the shared
//! [`AppHandleState`]. The picker fires `list_harness_models_refresh` when
//! the user clicks the overlay's reload button.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use raum_core::AgentKind;
use raum_core::harness::{HarnessModel, list_models};

use crate::state::AppHandleState;

const CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct ModelsCache {
    inner: Mutex<Vec<(AgentKind, Instant, Vec<HarnessModel>)>>,
}

impl ModelsCache {
    fn get(&self, kind: AgentKind) -> Option<Vec<HarnessModel>> {
        let guard = self.inner.lock().ok()?;
        guard
            .iter()
            .find(|(k, at, _)| *k == kind && at.elapsed() < CACHE_TTL)
            .map(|(_, _, v)| v.clone())
    }

    fn put(&self, kind: AgentKind, models: Vec<HarnessModel>) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.retain(|(k, _, _)| *k != kind);
            guard.push((kind, Instant::now(), models));
        }
    }

    fn invalidate(&self, kind: AgentKind) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.retain(|(k, _, _)| *k != kind);
        }
    }
}

#[tauri::command]
pub async fn list_harness_models(
    state: tauri::State<'_, AppHandleState>,
    kind: AgentKind,
) -> Result<Vec<HarnessModel>, String> {
    if let Some(cached) = state.models_cache.get(kind) {
        return Ok(cached);
    }
    let models = list_models(kind).await;
    state.models_cache.put(kind, models.clone());
    Ok(models)
}

#[tauri::command]
pub async fn list_harness_models_refresh(
    state: tauri::State<'_, AppHandleState>,
    kind: AgentKind,
) -> Result<Vec<HarnessModel>, String> {
    state.models_cache.invalidate(kind);
    let models = list_models(kind).await;
    state.models_cache.put(kind, models.clone());
    Ok(models)
}
