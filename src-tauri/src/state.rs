//! Tauri-managed shared state. Wave 2 fills in TmuxManager / agent registry / etc.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use raum_core::store::ConfigStore;
use raum_tmux::TmuxManager;

use crate::commands::agent::{AgentEventBus, AgentRegistry};
use crate::commands::git_watcher::GitHeadWatcher;

/// Shared app state. Other Wave-2 agents may add sibling fields here; keep the
/// additions additive so parallel waves don't clobber each other.
pub struct AppHandleState {
    pub config_store: Mutex<ConfigStore>,
    /// §3 — owns the `-L raum` tmux socket. Wrapped in `Arc` so we can hand
    /// clones to per-session background tasks without taking the Mutex.
    pub tmux: Arc<TmuxManager>,
    /// §3.4 — registry of live terminal sessions (Channel handles, fifo paths,
    /// coalescer join handles). Protected by a std `Mutex` because all command
    /// entry points are `#[tauri::command]` handlers running on a worker pool.
    pub terminals: Mutex<crate::commands::terminal::TerminalRegistry>,
    /// §7 — agent adapter registry + per-session state machines.
    pub agents: Mutex<AgentRegistry>,
    /// §7.8 — broadcast channel that fan-outs `AgentStateChanged` records from
    /// raum-core to the Tauri event bus. The bridge task is spawned lazily on
    /// first use (see `commands::agent::ensure_bridge_running`).
    pub agent_events: AgentEventBus,
    /// Per-project `.git/HEAD` watchers. Each entry emits
    /// `worktree-branches-changed` when the underlying HEAD changes so the UI
    /// can refresh branch badges without polling.
    pub git_watchers: Mutex<HashMap<String, GitHeadWatcher>>,
}

impl Default for AppHandleState {
    fn default() -> Self {
        Self {
            config_store: Mutex::new(ConfigStore::default()),
            tmux: Arc::new(TmuxManager::default()),
            terminals: Mutex::new(crate::commands::terminal::TerminalRegistry::default()),
            agents: Mutex::new(AgentRegistry::with_defaults()),
            agent_events: AgentEventBus::new(),
            git_watchers: Mutex::new(HashMap::new()),
        }
    }
}
