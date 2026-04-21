//! Tauri-managed shared state. Wave 2 fills in TmuxManager / agent registry / etc.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use raum_core::store::ConfigStore;
use raum_hooks::EventSocketHandle;
use raum_tmux::TmuxManager;

use crate::commands::agent::{AgentEventBus, AgentRegistry};
use crate::commands::git_watcher::GitHeadWatcher;
use crate::commands::harness_runtime::HarnessRuntimeRegistry;

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
    /// §7.6 — hook-event UDS socket handle. Populated once during Tauri
    /// `setup`; `None` when socket bind failed (logged as a warning so we
    /// degrade to the silence heuristic instead of crashing the app).
    ///
    /// The drain task that forwards events into the state-machine bridge
    /// takes ownership of the `rx` receiver; we keep the handle alive here
    /// only to hold the `JoinHandle` + socket path for diagnostics.
    pub event_socket: Mutex<Option<EventSocketHandle>>,
    /// Phase 6: per-session harness-runtime registry holding channels
    /// and repliers for the split trait surface
    /// (`HarnessRuntime` / `NotificationSetup`). Mirrors
    /// [`AgentRegistry`] but operates on the typed adapter structs so
    /// permission replies flow through the right transport (hook
    /// response, HTTP reply, …).
    pub harness_runtimes: HarnessRuntimeRegistry,
    /// Phase 6: `mpsc::Sender` clone used by notification channels to
    /// push events onto the same drain loop the UDS socket uses. Set
    /// once during `bootstrap_event_socket` so per-session channel
    /// tasks can push into it without touching the event socket
    /// handle's `rx` directly.
    pub channel_event_tx: Mutex<Option<tokio::sync::mpsc::Sender<raum_hooks::HookEvent>>>,
    /// Per-session timestamp of the last PTY output chunk, used by the
    /// silence-tick task (`commands::agent::spawn_silence_tick`) to drive
    /// fallback `Working -> Idle` and output-based `* -> Working`
    /// recovery when no explicit hook fires.
    /// Populated inside the PTY bytes callback in
    /// `commands::terminal::open_bridge_and_monitor`; cleared when a
    /// session is killed or reattached away from.
    pub session_activity: Arc<Mutex<HashMap<String, Instant>>>,
    /// Wall-clock timestamp (epoch seconds) of the most recent hook
    /// event received over the UDS socket or an SSE channel. `None`
    /// means nothing has ever arrived — the typical diagnostic answer
    /// to "why is raum not showing busy state?". Updated by
    /// `commands::agent::drive_event_socket`.
    pub last_hook_at: Arc<Mutex<Option<LastHook>>>,
}

/// Snapshot of the most recent hook event, surfaced via
/// `hooks_diagnostics` so the Harness Health UI can answer "are hooks
/// actually firing?" without the user digging through logs.
#[derive(Clone, Debug)]
pub struct LastHook {
    pub at_unix: u64,
    pub harness: String,
    pub event: String,
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
            event_socket: Mutex::new(None),
            harness_runtimes: HarnessRuntimeRegistry::new(),
            channel_event_tx: Mutex::new(None),
            session_activity: Arc::new(Mutex::new(HashMap::new())),
            last_hook_at: Arc::new(Mutex::new(None)),
        }
    }
}
