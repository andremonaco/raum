//! In-memory registry of live + ghost terminal sessions.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use raum_core::AgentKind;
use raum_tmux::PtyBridgeHandle;
use serde::Serialize;
use tokio::task::JoinHandle;

use super::entry::TerminalEntry;

#[derive(Debug, Clone, Serialize)]
pub struct TerminalListItem {
    pub session_id: String,
    pub project_slug: Option<String>,
    pub worktree_id: Option<String>,
    pub kind: AgentKind,
    pub created_unix: u64,
    /// True when the rehydrate path detected this session's tmux pane
    /// is dead (`pane_dead == 1`) and could not auto-revive it — so the
    /// frontend should render the Recover overlay instead of attaching
    /// a PTY bridge. Skipped from the wire when false to keep the
    /// shape stable for the common case.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dead: bool,
}

/// Identity-only terminal record. Populated by the startup rehydrate
/// bootstrap for tmux sessions that survived the previous app run but
/// have no PTY bridge yet; promoted to a full `TerminalEntry` when
/// `TerminalPane` mounts and `terminal_reattach` opens the bridge.
///
/// Kept in a separate map from real entries so `get_bridge` / resize /
/// input paths are untouched — they naturally return "not found" for a
/// ghost-only session, which is the correct behaviour until the bridge
/// is attached.
#[derive(Debug, Clone)]
pub struct GhostEntry {
    pub session_id: String,
    pub project_slug: Option<String>,
    pub worktree_id: Option<String>,
    pub kind: AgentKind,
    pub created_unix: u64,
    /// Carried into the emitted `TerminalListItem` so the sidebar can
    /// render a Recover affordance for dead panes that the rehydrate
    /// path couldn't auto-revive (Shell sessions, or harnesses where
    /// `respawn_with` failed).
    pub dead: bool,
}

impl GhostEntry {
    #[must_use]
    pub fn list_item(&self) -> TerminalListItem {
        TerminalListItem {
            session_id: self.session_id.clone(),
            project_slug: self.project_slug.clone(),
            worktree_id: self.worktree_id.clone(),
            kind: self.kind,
            created_unix: self.created_unix,
            dead: self.dead,
        }
    }
}

/// In-memory tracking for every live terminal session. The registry is owned
/// by `AppHandleState::terminals` behind a `Mutex`.
#[derive(Default)]
pub struct TerminalRegistry {
    entries: HashMap<String, TerminalEntry>,
    /// Identity-only rows for sessions whose tmux window is alive but
    /// whose PTY bridge hasn't been opened yet (populated by the
    /// startup rehydrate task). Promoted via `promote_ghost` at the
    /// start of `terminal_reattach`.
    ghosts: HashMap<String, GhostEntry>,
    /// Session ids with a `terminal_reattach` currently opening a fresh PTY
    /// bridge. Guards against duplicate frontend surfaces repeatedly tearing
    /// down and replacing each other's bridge for the same tmux session.
    reattaching: HashSet<String>,
}

impl TerminalRegistry {
    pub fn insert(&mut self, entry: TerminalEntry) {
        // An entry always wins over a ghost for the same session id.
        self.ghosts.remove(&entry.session_id);
        self.entries.insert(entry.session_id.clone(), entry);
    }

    pub fn remove(&mut self, session_id: &str) -> Option<TerminalEntry> {
        // Drop any ghost too so we don't leak an identity row when the
        // caller is removing the entry because the session is gone.
        self.ghosts.remove(session_id);
        self.entries.remove(session_id)
    }

    pub fn get_bridge(&self, session_id: &str) -> Option<PtyBridgeHandle> {
        self.entries.get(session_id).map(|e| e.bridge.clone())
    }

    /// Fetch both the bridge and the last-known dims atomically under the
    /// registry lock. Used by `terminal_resize` to pick a resize ordering
    /// that avoids tmux's hatched "|..." pattern.
    pub fn get_bridge_and_size(&self, session_id: &str) -> Option<(PtyBridgeHandle, u16, u16)> {
        self.entries
            .get(session_id)
            .map(|e| (e.bridge.clone(), e.last_cols, e.last_rows))
    }

    /// Update the last-applied cols/rows after a successful resize.
    pub fn update_size(&mut self, session_id: &str, cols: u16, rows: u16) {
        if let Some(e) = self.entries.get_mut(session_id) {
            e.last_cols = cols;
            e.last_rows = rows;
        }
    }

    pub(super) fn set_monitor_task(
        &mut self,
        session_id: &str,
        monitor_task: JoinHandle<()>,
    ) -> bool {
        let Some(entry) = self.entries.get_mut(session_id) else {
            monitor_task.abort();
            return false;
        };
        if let Some(existing) = entry.monitor_task.replace(monitor_task) {
            existing.abort();
        }
        true
    }

    /// Tear down the stale bridge + monitor on an existing entry without
    /// removing the entry itself. The entry stays visible to
    /// `terminal_list` so the top-row counters don't flash to zero while
    /// `terminal_reattach` is mid-flight; a follow-up `replace_bridge`
    /// lands the fresh bridge. Returns `true` iff the entry existed.
    pub fn detach_bridge(&mut self, session_id: &str) -> bool {
        let Some(entry) = self.entries.get_mut(session_id) else {
            return false;
        };
        if let Some(m) = entry.monitor_task.take() {
            m.abort();
        }
        if let Some(context) = entry.context_task.take() {
            context.abort();
        }
        entry.bridge_output_cancelled.store(true, Ordering::SeqCst);
        entry.bridge.shutdown_silent();
        true
    }

    /// Swap the live bridge/monitor/dims on an existing entry. Identity
    /// columns (`project_slug`, `worktree_id`, `kind`, `created_unix`)
    /// are preserved. Returns `true` iff the entry existed; when it
    /// returns `false` the caller's bridge + monitor are dropped.
    pub(super) fn replace_bridge(
        &mut self,
        session_id: &str,
        runtime: BridgeRuntime,
        cols: u16,
        rows: u16,
    ) -> bool {
        let Some(entry) = self.entries.get_mut(session_id) else {
            if let Some(monitor) = runtime.monitor_task {
                monitor.abort();
            }
            if let Some(context) = runtime.context_task {
                context.abort();
            }
            runtime
                .bridge_output_cancelled
                .store(true, Ordering::SeqCst);
            runtime.bridge.shutdown_silent();
            return false;
        };
        entry.bridge_output_cancelled.store(true, Ordering::SeqCst);
        entry.bridge = runtime.bridge;
        entry.bridge_output_cancelled = runtime.bridge_output_cancelled;
        entry.monitor_task = runtime.monitor_task;
        entry.context_task = runtime.context_task;
        entry.last_cols = cols;
        entry.last_rows = rows;
        true
    }

    pub fn item(&self, session_id: &str) -> Option<TerminalListItem> {
        if let Some(e) = self.entries.get(session_id) {
            return Some(e.list_item());
        }
        self.ghosts.get(session_id).map(GhostEntry::list_item)
    }

    pub fn list(&self) -> Vec<TerminalListItem> {
        let mut out: Vec<TerminalListItem> = self
            .entries
            .values()
            .map(|e| TerminalListItem {
                session_id: e.session_id.clone(),
                project_slug: e.project_slug.clone(),
                worktree_id: e.worktree_id.clone(),
                kind: e.kind,
                created_unix: e.created_unix,
                // Real entries are by definition live — the bridge is
                // attached. Dead-pane sessions stay as ghosts.
                dead: false,
            })
            .collect();
        // Only include ghosts whose id isn't already represented by a
        // real entry — a real entry always shadows a ghost (it means
        // reattach finished and the bridge is live).
        for g in self.ghosts.values() {
            if !self.entries.contains_key(&g.session_id) {
                out.push(g.list_item());
            }
        }
        out
    }

    /// Insert (or overwrite) a ghost identity row. If a real entry
    /// already exists for this session id the call is a no-op — the
    /// real entry is strictly more authoritative. Returns `true` when
    /// a ghost was newly inserted (or refreshed).
    pub fn upsert_ghost(&mut self, entry: GhostEntry) -> bool {
        if self.entries.contains_key(&entry.session_id) {
            return false;
        }
        self.ghosts.insert(entry.session_id.clone(), entry);
        true
    }

    /// Remove and return the ghost row for `session_id`, if any. Called
    /// by `terminal_reattach` before it constructs the real
    /// `TerminalEntry` so identity metadata (project_slug,
    /// worktree_id, created_unix) is carried forward. Returns `None`
    /// when no ghost exists — the caller should build the entry from
    /// its own arguments.
    pub fn promote_ghost(&mut self, session_id: &str) -> Option<GhostEntry> {
        self.ghosts.remove(session_id)
    }

    pub fn begin_reattach(&mut self, session_id: &str) -> bool {
        self.reattaching.insert(session_id.to_string())
    }

    pub fn finish_reattach(&mut self, session_id: &str) {
        self.reattaching.remove(session_id);
    }
}

impl std::fmt::Debug for TerminalRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalRegistry")
            .field("count", &self.entries.len())
            .field("ghosts", &self.ghosts.len())
            .field("reattaching", &self.reattaching.len())
            .finish()
    }
}

/// Bundle of fresh PTY bridge handles passed into
/// [`TerminalRegistry::replace_bridge`] when an in-flight reattach
/// finishes. Lets the registry decide atomically whether to install
/// them on the existing entry or drop them when the entry has been
/// removed concurrently.
pub(super) struct BridgeRuntime {
    pub(super) bridge: PtyBridgeHandle,
    pub(super) bridge_output_cancelled: Arc<AtomicBool>,
    pub(super) monitor_task: Option<JoinHandle<()>>,
    pub(super) context_task: Option<JoinHandle<()>>,
}
