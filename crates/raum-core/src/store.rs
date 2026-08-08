//! ConfigStore — atomic TOML reads/writes anchored at `~/.config/raum/`.
//! Fulfils §2.2, §2.3, §2.6 in Wave 1A.
//!
//! Every TOML in raum flows through this module: it guarantees atomic writes
//! (temp-file + rename), 0700 tree perms on Unix, and a single schema version.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use parking_lot::Mutex;
use serde::Serialize;
use serde::de::DeserializeOwned;
use thiserror::Error;
use tracing::{debug, info, warn};

use crate::agent::{AgentKind, AgentState};
use crate::config::{
    ActiveLayoutState, Config, EffectiveProjectConfig, Keybindings, ProjectConfig,
    QuickfireHistory, RaumToml, SessionState, TrackedSession,
};
use crate::paths;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("toml deserialize: {0}")]
    TomlDe(#[from] toml::de::Error),
    #[error("toml serialize: {0}")]
    TomlSer(#[from] toml::ser::Error),
    #[error("invalid project slug: {0}")]
    InvalidSlug(String),
}

/// Stat fingerprint used to decide whether a cached parse is still valid.
/// `mtime` alone can miss same-millisecond rewrites on coarse-granularity
/// filesystems, so the length rides along as a cheap second signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    mtime: SystemTime,
    len: u64,
}

impl FileStamp {
    /// `None` when the file is absent or unstattable — the caller then
    /// treats the cache as cold rather than guessing.
    fn of(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        Some(Self {
            mtime: meta.modified().ok()?,
            len: meta.len(),
        })
    }
}

#[derive(Debug)]
pub struct ConfigStore {
    pub root: PathBuf,
    /// Parsed `state/sessions.toml` keyed by the file's stat fingerprint.
    ///
    /// Every hook event fans out into several session accessors and each of
    /// them used to re-read and re-parse the whole file. The cache collapses
    /// that to one stat per call while staying honest about external edits:
    /// the file-watcher, a hand-edit, or a second raum process all bump the
    /// fingerprint, which forces a reparse. Lifecycle writes (anything that
    /// changes the row *set*) stay synchronous and atomic — `sessions.toml`
    /// is the recovery authority; the cache is refreshed *after* the rename
    /// lands. Display-only field updates go through
    /// [`ConfigStore::write_sessions_debounced`].
    sessions_cache: Arc<Mutex<Option<(FileStamp, SessionState)>>>,
    /// Display-only `sessions.toml` update awaiting its coalesced disk write.
    sessions_pending: Arc<Mutex<PendingSessions>>,
    /// Same stat-fingerprint deal for `config.toml` — read three times during
    /// bootstrap and from ~10 frontend command handlers.
    config_cache: Mutex<Option<(FileStamp, Config)>>,
    /// …and for `projects/<slug>/project.toml`, keyed by slug (a project list
    /// walks every slug, so a single-entry cache would just thrash).
    project_cache: Mutex<HashMap<String, (FileStamp, ProjectConfig)>>,
}

impl Default for ConfigStore {
    fn default() -> Self {
        Self::new(paths::config_root())
    }
}

impl ConfigStore {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            sessions_cache: Arc::new(Mutex::new(None)),
            sessions_pending: Arc::new(Mutex::new(PendingSessions::default())),
            config_cache: Mutex::new(None),
            project_cache: Mutex::new(HashMap::new()),
        }
    }

    // ---- directory bootstrap ------------------------------------------------

    /// Ensure `~/.config/raum/{projects,hooks,state,logs}` exist with 0700
    /// perms, and write a default `config.toml` if missing.
    pub fn ensure_layout(&self) -> Result<(), StoreError> {
        ensure_dir_0700(&self.root)?;
        ensure_dir_0700(&self.root.join("projects"))?;
        ensure_dir_0700(&self.root.join("hooks"))?;
        ensure_dir_0700(&self.root.join("state"))?;
        ensure_dir_0700(&self.root.join("logs"))?;

        let cfg = self.root.join("config.toml");
        if !cfg.exists() {
            info!(path = %cfg.display(), "writing default config.toml");
            self.write_config(&Config::default())?;
        }

        // Touch empty keybindings.toml so users discover the file.
        let kb = self.root.join("keybindings.toml");
        if !kb.exists() {
            atomic_write(&kb, b"")?;
        }
        Ok(())
    }

    // ---- config.toml --------------------------------------------------------

    pub fn read_config(&self) -> Result<Config, StoreError> {
        let path = self.config_path();
        let (cfg, parsed) = read_cached_slot::<Config>(&path, &mut self.config_cache.lock())?;
        if parsed {
            log_unknown_keys("config.toml", &cfg.unknown);
        }
        Ok(cfg)
    }

    pub fn write_config(&self, cfg: &Config) -> Result<(), StoreError> {
        let path = self.config_path();
        let mut cache = self.config_cache.lock();
        *cache = None;
        write_toml(&path, cfg)?;
        *cache = FileStamp::of(&path).map(|stamp| (stamp, cfg.clone()));
        Ok(())
    }

    fn config_path(&self) -> PathBuf {
        self.root.join("config.toml")
    }

    // ---- projects/<slug>/project.toml --------------------------------------

    pub fn read_project(&self, slug: &str) -> Result<Option<ProjectConfig>, StoreError> {
        validate_slug(slug)?;
        let path = self.project_path(slug);
        let Some(stamp) = FileStamp::of(&path) else {
            self.project_cache.lock().remove(slug);
            return Ok(None);
        };
        let mut cache = self.project_cache.lock();
        if let Some((cached_stamp, cached)) = cache.get(slug)
            && *cached_stamp == stamp
        {
            return Ok(Some(cached.clone()));
        }
        let raw = std::fs::read_to_string(&path)?;
        let project: ProjectConfig = toml::from_str(&raw)?;
        log_unknown_keys(&format!("projects/{slug}/project.toml"), &project.unknown);
        // Only cache when the file didn't move under us mid-parse (see
        // `read_cached_slot`).
        if FileStamp::of(&path) == Some(stamp) {
            cache.insert(slug.to_string(), (stamp, project.clone()));
        }
        Ok(Some(project))
    }

    pub fn write_project(&self, project: &ProjectConfig) -> Result<(), StoreError> {
        validate_slug(&project.slug)?;
        let dir = self.root.join("projects").join(&project.slug);
        ensure_dir_0700(&dir)?;
        let path = dir.join("project.toml");
        let mut cache = self.project_cache.lock();
        cache.remove(&project.slug);
        write_toml(&path, project)?;
        if let Some(stamp) = FileStamp::of(&path) {
            cache.insert(project.slug.clone(), (stamp, project.clone()));
        }
        Ok(())
    }

    pub fn list_project_slugs(&self) -> Result<Vec<String>, StoreError> {
        let dir = self.root.join("projects");
        if !dir.exists() {
            return Ok(vec![]);
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&dir)? {
            let e = entry?;
            if e.file_type()?.is_dir() {
                if let Some(name) = e.file_name().to_str() {
                    out.push(name.to_string());
                }
            }
        }
        out.sort();
        Ok(out)
    }

    pub fn delete_project(&self, slug: &str) -> Result<(), StoreError> {
        validate_slug(slug)?;
        let dir = self.root.join("projects").join(slug);
        self.project_cache.lock().remove(slug);
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        Ok(())
    }

    fn project_path(&self, slug: &str) -> PathBuf {
        self.root.join("projects").join(slug).join("project.toml")
    }

    // ---- keybindings.toml ---------------------------------------------------

    pub fn read_keybindings(&self) -> Result<Keybindings, StoreError> {
        read_toml_or_default(&self.root.join("keybindings.toml"))
    }

    pub fn write_keybindings(&self, kb: &Keybindings) -> Result<(), StoreError> {
        write_toml(&self.root.join("keybindings.toml"), kb)
    }

    // ---- state/sessions.toml ------------------------------------------------

    fn sessions_path(&self) -> PathBuf {
        self.root.join("state").join("sessions.toml")
    }

    /// Read `state/sessions.toml`, reusing the in-memory parse when the file
    /// is byte-identical (same mtime + size) to the one we last saw. A
    /// changed file — file-watcher reload, external edit, another raum
    /// process — reparses.
    pub fn read_sessions(&self) -> Result<SessionState, StoreError> {
        read_cached_slot(&self.sessions_path(), &mut self.sessions_cache.lock())
            .map(|(state, _parsed)| state)
    }

    /// Immediate, crash-consistent write. Use for every mutation that changes
    /// the *set* of tracked rows (insert / remove / adopt) — that set is the
    /// recovery authority and must never lag memory on disk.
    ///
    /// Discards any pending debounced write: `state` is always derived from
    /// [`read_sessions`], which serves the cache, and the cache already
    /// carries the pending edits. Writing the older pending value first would
    /// only invert the on-disk ordering.
    pub fn write_sessions(&self, state: &SessionState) -> Result<(), StoreError> {
        let mut pending = self.sessions_pending.lock();
        pending.state = None;
        pending.deadline = None;
        write_sessions_to(&self.sessions_path(), &self.sessions_cache, state)
    }

    /// Cache-immediate, disk-deferred sibling of [`write_sessions`] for
    /// display-only field updates on rows that already exist (`last_state`).
    ///
    /// The in-memory cache — which every reader goes through — is updated
    /// now, so nothing ever observes a stale value. Only the atomic disk
    /// write is coalesced into one per [`SESSIONS_DEBOUNCE`] quiet window,
    /// which collapses a screenful of panes toggling Working/Waiting on every
    /// tool call into a single serialize + fsync.
    ///
    /// Recovery *does* read `last_state` (`rehydrate_plan` seeds the state
    /// machine from it), so the tail this can lose is not free — but it is
    /// self-correcting as long as `last_state_acked` on disk never gets
    /// *ahead* of it. `ack_session_last_state` writes the flag through
    /// immediately, so `update_session_last_state` must too whenever it
    /// clears an ack; only ack-neutral touches land here.
    fn write_sessions_debounced(&self, state: &SessionState) -> Result<(), StoreError> {
        let path = self.sessions_path();
        // Lock order everywhere: `sessions_pending` before `sessions_cache`.
        let mut pending = self.sessions_pending.lock();
        let Some(stamp) = FileStamp::of(&path) else {
            // No file on disk yet: there is no stamp to cache against, so a
            // deferred write would leave readers seeing the absent-file
            // default. Write it through.
            return write_sessions_to(&path, &self.sessions_cache, state);
        };
        // Cached against the *current* (pre-flush) stamp, so an external edit
        // still invalidates the entry exactly as it would without debouncing.
        *self.sessions_cache.lock() = Some((stamp, state.clone()));
        pending.state = Some(state.clone());
        pending.deadline = Some(Instant::now() + SESSIONS_DEBOUNCE);
        if pending.armed {
            return Ok(());
        }
        pending.armed = true;
        drop(pending);
        spawn_sessions_flusher(
            path,
            Arc::clone(&self.sessions_cache),
            Arc::clone(&self.sessions_pending),
        );
        Ok(())
    }

    /// Write any pending debounced `sessions.toml` update to disk right now.
    /// Wired into the quit-flush path (Contract 1) so the final state
    /// transitions before exit are never lost. Idempotent — a call with
    /// nothing outstanding does no IO.
    pub fn flush_sessions(&self) {
        let mut pending = self.sessions_pending.lock();
        pending.deadline = None;
        let Some(state) = pending.state.take() else {
            return;
        };
        if let Err(e) = write_sessions_to(&self.sessions_path(), &self.sessions_cache, &state) {
            warn!(error = %e, "sessions.toml quit flush failed");
        }
    }

    /// Upsert the last-known `AgentState` for `session_id`. If a tracked row
    /// for the session already exists its `last_state` + timestamp are
    /// overwritten; otherwise a minimal row is inserted so reattach can find
    /// it on the next app launch. Used by the agent-event bridge task to
    /// persist every state transition.
    pub fn update_session_last_state(
        &self,
        session_id: &str,
        harness: AgentKind,
        state: AgentState,
        at_unix_ms: u64,
    ) -> Result<(), StoreError> {
        let mut st = self.read_sessions().unwrap_or_default();
        if let Some(row) = st.sessions.iter_mut().find(|s| s.session_id == session_id) {
            row.last_state = Some(state);
            row.last_state_at_unix_ms = Some(at_unix_ms);
            // A fresh transition is unread again — the user hasn't seen this
            // state yet, so clear any prior acknowledgment. Otherwise a
            // completion that later flips to working-then-done would inherit
            // the old "seen" flag and never re-surface in the rail.
            let cleared_ack = std::mem::replace(&mut row.last_state_acked, false);
            return if cleared_ack {
                // The ack was written through immediately; deferring its
                // clear would let a crash resurrect it on disk *without* the
                // transition that invalidated it, permanently hiding the next
                // completion from the attention rail. Ack flips are
                // user-paced, so there is nothing worth coalescing here.
                self.write_sessions(&st)
            } else {
                // Ack-neutral field touch on an existing row: display
                // metadata, so the disk write is coalesced (see
                // `write_sessions_debounced`).
                self.write_sessions_debounced(&st)
            };
        }
        st.sessions.push(TrackedSession {
            session_id: session_id.to_string(),
            project_slug: None,
            worktree_id: None,
            opencode_port: None,
            kind: harness,
            created_at_unix_ms: at_unix_ms,
            last_state: Some(state),
            last_state_at_unix_ms: Some(at_unix_ms),
            last_state_acked: false,
            last_prompt_text: None,
            last_prompt_at_unix_ms: None,
            harness_session_id: None,
        });
        // Inserting a row changes the tracked *set* — write it through.
        self.write_sessions(&st)
    }

    /// Mark the tracked row's `last_state` as *seen* by the user (e.g. the
    /// completion was dismissed in the attention rail). Best-effort: a
    /// missing row is a no-op success — the frontend acks by session id and
    /// a shell session (or a session torn down between the emit and the ack)
    /// simply has nothing to flag. Mirrors `update_session_last_state`'s
    /// read-modify-write + atomic save. The flag is cleared again on the next
    /// state transition (see `update_session_last_state`), so an ack only
    /// silences the exact state the user actually saw.
    pub fn ack_session_last_state(&self, session_id: &str) -> Result<(), StoreError> {
        let mut st = self.read_sessions().unwrap_or_default();
        let Some(row) = st.sessions.iter_mut().find(|s| s.session_id == session_id) else {
            return Ok(());
        };
        if row.last_state_acked {
            return Ok(());
        }
        row.last_state_acked = true;
        self.write_sessions(&st)
    }

    /// Upsert the most recently submitted prompt for `session_id`. The
    /// session row must already exist (created by either
    /// `update_session_last_state` or `upsert_tracked_session`) for the
    /// write to take effect. The agent-event bridge tolerates a missing
    /// row — the prompt simply isn't persisted that turn — because the
    /// state-change path will register the row on its own emit and the
    /// next prompt persists then.
    pub fn update_session_last_prompt(
        &self,
        session_id: &str,
        text: &str,
        at_unix_ms: u64,
    ) -> Result<(), StoreError> {
        let mut st = self.read_sessions().unwrap_or_default();
        let Some(row) = st.sessions.iter_mut().find(|s| s.session_id == session_id) else {
            return Ok(());
        };
        row.last_prompt_text = Some(text.to_string());
        row.last_prompt_at_unix_ms = Some(at_unix_ms);
        // NOT debounced despite being a field-only update: `rehydrate_plan`
        // reads `last_prompt_text` to decide Recover vs Forget after the tmux
        // server dies, so losing the tail of this stream in a crash could
        // downgrade a recoverable session to a forgotten one. It is also
        // human-paced (one write per submitted prompt), so there is nothing
        // to coalesce.
        self.write_sessions(&st)
    }

    /// Upsert the harness's *own* session id (Claude Code / Codex UUID)
    /// for `session_id`. Captured from any hook payload so post-restart
    /// pane overlays can disambiguate between multiple sessions sharing
    /// one worktree directory.
    ///
    /// Updated when a later hook reports a different value. Older raum builds
    /// briefly guessed ids from cwd-newest transcript discovery; a real hook
    /// payload must be allowed to repair that bad persisted value.
    ///
    /// Inserts a row when one doesn't yet exist, mirroring
    /// `update_session_last_state`. The first hook event for a fresh
    /// session arrives before the agent-event bridge has had a chance
    /// to persist any state, so a "row must already exist" contract
    /// would lose the very first id.
    pub fn update_session_harness_id(
        &self,
        session_id: &str,
        harness: AgentKind,
        harness_session_id: &str,
        at_unix_ms: u64,
    ) -> Result<(), StoreError> {
        let mut st = self.read_sessions().unwrap_or_default();
        if let Some(row) = st.sessions.iter_mut().find(|s| s.session_id == session_id) {
            if row.harness_session_id.as_deref() == Some(harness_session_id) {
                return Ok(());
            }
            row.harness_session_id = Some(harness_session_id.to_string());
        } else {
            st.sessions.push(TrackedSession {
                session_id: session_id.to_string(),
                project_slug: None,
                worktree_id: None,
                opencode_port: None,
                kind: harness,
                created_at_unix_ms: at_unix_ms,
                last_state: None,
                last_state_at_unix_ms: None,
                last_state_acked: false,
                last_prompt_text: None,
                last_prompt_at_unix_ms: None,
                harness_session_id: Some(harness_session_id.to_string()),
            });
        }
        // NOT debounced, same reason as `update_session_last_prompt`:
        // `harness_session_id` is the primary Recover key in `rehydrate_plan`.
        // Sticky once set, so this writes roughly once per session anyway.
        self.write_sessions(&st)
    }

    /// Fetch the persisted harness session id for `session_id`. Returns
    /// `None` if no `UserPromptSubmit` has fired yet (or the session is
    /// shell-only).
    #[must_use]
    pub fn last_session_harness_id(&self, session_id: &str) -> Option<String> {
        self.read_sessions()
            .ok()?
            .sessions
            .into_iter()
            .find(|s| s.session_id == session_id)
            .and_then(|s| s.harness_session_id)
    }

    /// Fetch the last persisted prompt + timestamp for `session_id`. Used
    /// by the reattach seed path so a freshly-launched raum repopulates
    /// the tab subtitle without the user re-submitting.
    #[must_use]
    pub fn last_session_prompt(&self, session_id: &str) -> Option<(String, u64)> {
        let st = self.read_sessions().ok()?;
        let row = st
            .sessions
            .into_iter()
            .find(|s| s.session_id == session_id)?;
        Some((row.last_prompt_text?, row.last_prompt_at_unix_ms?))
    }

    /// Fetch the last persisted `AgentState` for `session_id`, if any.
    /// Cheap convenience for the reattach seed path.
    pub fn last_session_state(&self, session_id: &str) -> Option<AgentState> {
        self.read_sessions()
            .ok()?
            .sessions
            .into_iter()
            .find(|s| s.session_id == session_id)
            .and_then(|s| s.last_state)
    }

    /// Fetch the persisted state metadata for `session_id`:
    /// `(last_state_at_unix_ms, last_state_acked)`. Sibling of
    /// [`last_session_state`] used by the `agent_list` / `agent_snapshot` /
    /// `agent_state` join so the frontend can render the *true* completion
    /// age (not a fabricated `Date.now()` on reload) and know whether the
    /// user already dismissed it. Returns `None` when no tracked row exists.
    #[must_use]
    pub fn session_state_meta(&self, session_id: &str) -> Option<(Option<u64>, bool)> {
        self.read_sessions()
            .ok()?
            .sessions
            .into_iter()
            .find(|s| s.session_id == session_id)
            .map(|s| (s.last_state_at_unix_ms, s.last_state_acked))
    }

    /// Write-once metadata registration for a session. Called once per session
    /// from the per-session registration path (`register_harness_session_runtime`)
    /// so `state/sessions.toml` carries the `project_slug` / `worktree_id`
    /// pairing that `update_session_last_state` doesn't know about. Safe to
    /// call repeatedly: existing metadata is preserved, only a filled-in
    /// `project_slug` / `worktree_id` can fill a previously `None` slot
    /// (first writer wins).
    pub fn upsert_tracked_session(
        &self,
        session_id: &str,
        harness: AgentKind,
        project_slug: Option<&str>,
        worktree_id: Option<&str>,
        opencode_port: Option<u16>,
        created_at_unix_ms: u64,
    ) -> Result<(), StoreError> {
        self.upsert_tracked_sessions(&[TrackedSessionUpsert {
            session_id,
            harness,
            project_slug,
            worktree_id,
            opencode_port,
            created_at_unix_ms,
        }])
    }

    /// Batch [`upsert_tracked_session`]: identical write-once semantics per
    /// row, but a single atomic write for the whole slice. Startup paths that
    /// register N sessions used to rewrite the entire file N times.
    pub fn upsert_tracked_sessions(
        &self,
        rows: &[TrackedSessionUpsert<'_>],
    ) -> Result<(), StoreError> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut st = self.read_sessions().unwrap_or_default();
        for row in rows {
            upsert_row(&mut st, row);
        }
        self.write_sessions(&st)
    }

    /// Drop the tracked row for `session_id`. Called when the session is
    /// torn down so the next launch doesn't try to re-hydrate a state for a
    /// tmux window that no longer exists.
    pub fn forget_session(&self, session_id: &str) -> Result<(), StoreError> {
        self.forget_sessions(std::slice::from_ref(&session_id))
    }

    /// Batch [`forget_session`] — one atomic write for the whole set instead
    /// of one per id (boot rehydrate forgets every stale row at once).
    pub fn forget_sessions(&self, session_ids: &[&str]) -> Result<(), StoreError> {
        if session_ids.is_empty() {
            return Ok(());
        }
        let mut st = self.read_sessions().unwrap_or_default();
        let before = st.sessions.len();
        // ponytail: linear membership per row; both sides are tens of entries.
        // Swap in a HashSet if sessions.toml ever grows past a few hundred.
        st.sessions
            .retain(|s| !session_ids.contains(&s.session_id.as_str()));
        if st.sessions.len() == before {
            return Ok(());
        }
        self.write_sessions(&st)
    }

    // ---- state/quickfire-history.toml --------------------------------------

    pub fn read_quickfire_history(&self) -> Result<QuickfireHistory, StoreError> {
        read_toml_or_default(&self.root.join("state").join("quickfire-history.toml"))
    }

    pub fn write_quickfire_history(&self, hist: &QuickfireHistory) -> Result<(), StoreError> {
        ensure_dir_0700(&self.root.join("state"))?;
        write_toml(
            &self.root.join("state").join("quickfire-history.toml"),
            hist,
        )
    }

    // ---- state/active-layout.toml ------------------------------------------

    pub fn read_active_layout(&self) -> Result<ActiveLayoutState, StoreError> {
        read_toml_or_default(&self.root.join("state").join("active-layout.toml"))
    }

    /// Like [`read_active_layout`] but also reports whether the on-disk file
    /// was corrupt and got quarantined on this read. The flag lets the
    /// frontend surface a "saved layout couldn't be read, set aside" toast on
    /// the success path — the read itself still degrades gracefully to the
    /// default (never a hard error), so the corruption is otherwise invisible.
    pub fn read_active_layout_checked(&self) -> Result<(ActiveLayoutState, bool), StoreError> {
        read_toml_tracked(&self.root.join("state").join("active-layout.toml"))
    }

    pub fn write_active_layout(&self, state: &ActiveLayoutState) -> Result<(), StoreError> {
        ensure_dir_0700(&self.root.join("state"))?;
        write_toml(&self.root.join("state").join("active-layout.toml"), state)
    }

    // ---- .raum.toml (§2.6) --------------------------------------------------

    /// Read `<repo_root>/.raum.toml` if present. Parse failures log a WARN and
    /// return `Ok(None)` so a broken in-repo file never blocks the app.
    pub fn read_raum_toml(&self, repo_root: &Path) -> Result<Option<RaumToml>, StoreError> {
        let path = repo_root.join(".raum.toml");
        if !path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(&path)?;
        match toml::from_str::<RaumToml>(&raw) {
            Ok(parsed) => {
                log_unknown_keys(&path.display().to_string(), &parsed.unknown);
                Ok(Some(parsed))
            }
            Err(e) => {
                warn!(path = %path.display(), error = %e, "failed to parse .raum.toml; ignoring");
                Ok(None)
            }
        }
    }

    /// Build the effective config a project runs with: user-level `project.toml`
    /// deep-merged with the repo-level `.raum.toml` when present. See §2.6 /
    /// design D13.
    pub fn effective_project(
        &self,
        slug: &str,
    ) -> Result<Option<EffectiveProjectConfig>, StoreError> {
        let Some(project) = self.read_project(slug)? else {
            return Ok(None);
        };
        let raum_toml = self.read_raum_toml(&project.root_path)?;
        Ok(Some(merge_project_with_raum_toml(
            &project,
            raum_toml.as_ref(),
        )))
    }
}

/// One row for [`ConfigStore::upsert_tracked_sessions`] — the borrowed form of
/// [`ConfigStore::upsert_tracked_session`]'s argument list.
#[derive(Debug, Clone, Copy)]
pub struct TrackedSessionUpsert<'a> {
    pub session_id: &'a str,
    pub harness: AgentKind,
    pub project_slug: Option<&'a str>,
    pub worktree_id: Option<&'a str>,
    pub opencode_port: Option<u16>,
    pub created_at_unix_ms: u64,
}

/// Apply one upsert to an in-memory `SessionState`. Metadata is write-once: a
/// later caller holding `None` must never clobber an existing `Some`, and one
/// holding `Some` only wins where the current value is `None`.
fn upsert_row(st: &mut SessionState, row: &TrackedSessionUpsert<'_>) {
    if let Some(existing) = st
        .sessions
        .iter_mut()
        .find(|s| s.session_id == row.session_id)
    {
        if existing.project_slug.is_none()
            && let Some(slug) = row.project_slug
        {
            existing.project_slug = Some(slug.to_string());
        }
        if existing.worktree_id.is_none()
            && let Some(wt) = row.worktree_id
        {
            existing.worktree_id = Some(wt.to_string());
        }
        if existing.opencode_port.is_none() {
            existing.opencode_port = row.opencode_port;
        }
        return;
    }
    st.sessions.push(TrackedSession {
        session_id: row.session_id.to_string(),
        project_slug: row.project_slug.map(str::to_string),
        worktree_id: row.worktree_id.map(str::to_string),
        opencode_port: row.opencode_port,
        kind: row.harness,
        created_at_unix_ms: row.created_at_unix_ms,
        last_state: None,
        last_state_at_unix_ms: None,
        last_state_acked: false,
        last_prompt_text: None,
        last_prompt_at_unix_ms: None,
        harness_session_id: None,
    });
}

/// Deep-merge a `ProjectConfig` with an optional `.raum.toml`. When a field in
/// `.raum.toml` is `Some`, it replaces the project value; otherwise the project
/// value is kept.
///
/// Matches D13: `.raum.toml` overrides the user-level `project.toml` for
/// `hydration`, `worktree`, and `agent_defaults`. Other fields (color, name,
/// slug, root_path, `in_repo_settings`) stay at project-level.
#[must_use]
pub fn merge_project_with_raum_toml(
    project: &ProjectConfig,
    raum_toml: Option<&RaumToml>,
) -> EffectiveProjectConfig {
    let has_raum_toml = raum_toml.is_some();
    let (hydration, worktree, agent_defaults) = match raum_toml {
        Some(rt) => (
            rt.hydration
                .clone()
                .unwrap_or_else(|| project.hydration.clone()),
            rt.worktree
                .clone()
                .unwrap_or_else(|| project.worktree.clone()),
            rt.agent_defaults
                .clone()
                .unwrap_or_else(|| project.agent_defaults.clone()),
        ),
        None => (
            project.hydration.clone(),
            project.worktree.clone(),
            project.agent_defaults.clone(),
        ),
    };

    EffectiveProjectConfig {
        slug: project.slug.clone(),
        name: project.name.clone(),
        root_path: project.root_path.clone(),
        color: project.color.clone(),
        sigil: crate::sigil::resolve_sigil(&project.slug, project.sigil.as_deref()),
        hydration,
        worktree,
        agent_defaults,
        in_repo_settings: project.in_repo_settings,
        has_raum_toml,
    }
}

fn validate_slug(slug: &str) -> Result<(), StoreError> {
    if slug.is_empty() || slug.contains('/') || slug.contains('\\') || slug.contains("..") {
        return Err(StoreError::InvalidSlug(slug.into()));
    }
    Ok(())
}

/// Stat-fingerprinted read: hand back the cached parse when `path` is
/// unchanged since `slot` was filled, otherwise reparse and refresh it. The
/// returned flag is `true` when this call actually parsed (used to keep the
/// unknown-keys log one-shot rather than once per cache hit).
fn read_cached_slot<T: DeserializeOwned + Default + Clone>(
    path: &Path,
    slot: &mut Option<(FileStamp, T)>,
) -> Result<(T, bool), StoreError> {
    let Some(stamp) = FileStamp::of(path) else {
        // Absent (or unstattable): nothing worth caching, and any cached
        // parse now describes a file that no longer exists.
        *slot = None;
        return read_toml_or_default(path).map(|v| (v, true));
    };
    if let Some((cached_stamp, cached)) = slot.as_ref()
        && *cached_stamp == stamp
    {
        return Ok((cached.clone(), false));
    }
    let value: T = read_toml_or_default(path)?;
    // Re-stat after the parse: if the file moved underneath us (including the
    // corrupt-file quarantine rename inside `read_toml_or_default`) the
    // fingerprint would be a lie, so leave the cache cold instead.
    *slot = (FileStamp::of(path) == Some(stamp)).then(|| (stamp, value.clone()));
    Ok((value, true))
}

fn read_toml_or_default<T: DeserializeOwned + Default>(path: &Path) -> Result<T, StoreError> {
    read_toml_tracked(path).map(|(value, _quarantined)| value)
}

/// Core of [`read_toml_or_default`], additionally reporting whether a corrupt
/// file was quarantined on this read (`true`) or the read was clean / the file
/// absent (`false`). [`read_toml_or_default`] discards the flag; callers that
/// want to surface the quarantine (e.g. the active-layout read) use this.
fn read_toml_tracked<T: DeserializeOwned + Default>(path: &Path) -> Result<(T, bool), StoreError> {
    if !path.exists() {
        return Ok((T::default(), false));
    }
    let raw = std::fs::read_to_string(path)?;
    if raw.trim().is_empty() {
        return Ok((T::default(), false));
    }
    match toml::from_str(&raw) {
        Ok(parsed) => Ok((parsed, false)),
        // A non-empty file that fails to parse is corrupt (interrupted
        // write before the atomic rename window closed, a hand-edit, or a
        // value a future/older schema can't deserialize). Returning the
        // error here used to bubble all the way up — `config_get` /
        // `active_layout_get` rejected, and the frontend's catch path then
        // re-opened the save gate and clobbered the recoverable file with
        // empty state. Mirror the graceful `read_raum_toml` pattern: move
        // the bad file aside (best-effort) so the user can salvage it by
        // hand, log a WARN, and fall back to `T::default()` so the read
        // path NEVER turns a corrupt file into a hard failure.
        Err(e) => {
            quarantine_bad_toml(path, &e);
            Ok((T::default(), true))
        }
    }
}

/// Best-effort rename of a corrupt TOML to `<path>.bad-<unix_ms>` so the
/// user keeps the recoverable bytes while the read path degrades to a
/// default. Logs the parse error either way. Failures to rename are logged
/// and swallowed — the caller still gets `T::default()`.
fn quarantine_bad_toml(path: &Path, err: &toml::de::Error) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let backup = {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("config.toml");
        path.with_file_name(format!("{name}.bad-{stamp}"))
    };
    match std::fs::rename(path, &backup) {
        Ok(()) => warn!(
            path = %path.display(),
            backup = %backup.display(),
            error = %err,
            "failed to parse TOML; quarantined corrupt file and fell back to default",
        ),
        Err(rename_err) => warn!(
            path = %path.display(),
            error = %err,
            rename_error = %rename_err,
            "failed to parse TOML; quarantine rename failed, falling back to default",
        ),
    }
}

fn write_toml<T: Serialize>(path: &Path, value: &T) -> Result<(), StoreError> {
    let raw = toml::to_string_pretty(value)?;
    atomic_write(path, raw.as_bytes())
}

fn log_unknown_keys(origin: &str, unknown: &std::collections::BTreeMap<String, toml::Value>) {
    if unknown.is_empty() {
        return;
    }
    let keys: Vec<&str> = unknown.keys().map(String::as_str).collect();
    info!(origin, unknown_keys = ?keys, "TOML contains unknown keys; preserved as-is");
}

/// Monotonic suffix for temp files. The pid alone is not enough: two
/// concurrent writers inside one process targeting the same path would pick
/// the same temp name and clobber each other's half-written bytes before
/// either rename landed.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Atomic, durable write: write to `<path>.<pid>.<seq>.tmp`, `fsync` it, then
/// `rename` onto `<path>`. On POSIX `rename(2)` is atomic on the same
/// filesystem, which `~/.config/raum/` is by definition.
///
/// The `sync_all` before the rename is what makes the atomicity meaningful
/// across a power loss / hard reboot: without it the rename can be durable
/// while the data blocks it points at are not, leaving a zero-length or
/// torn file where the recovery authority used to be. The parent-directory
/// fsync afterwards makes the rename itself durable; it is best-effort
/// because some filesystems refuse to sync a directory handle.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("raum.tmp");
    let pid = std::process::id();
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!(".{file_name}.{pid}.{seq}.tmp"));
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    if let Some(parent) = path.parent()
        && let Ok(dir) = std::fs::File::open(parent)
    {
        let _ = dir.sync_all();
    }
    debug!(path = %path.display(), bytes = bytes.len(), "atomic toml write");
    Ok(())
}

#[cfg(unix)]
fn ensure_dir_0700(path: &Path) -> Result<(), StoreError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path)?;
    let perms = std::fs::Permissions::from_mode(0o700);
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn ensure_dir_0700(path: &Path) -> Result<(), StoreError> {
    std::fs::create_dir_all(path)?;
    Ok(())
}

// ============================================================================
// sessions.toml write debouncing (§2.3)
// ============================================================================

/// Quiet window for coalescing display-only `sessions.toml` updates. Matches
/// the documented 500 ms config-write debounce.
const SESSIONS_DEBOUNCE: Duration = Duration::from_millis(500);

/// A `sessions.toml` write deferred by
/// [`ConfigStore::write_sessions_debounced`].
#[derive(Debug, Default)]
struct PendingSessions {
    /// Value still owed to disk; `None` means nothing is outstanding.
    state: Option<SessionState>,
    /// Pushed out by every submit inside the window, so the flusher re-sleeps
    /// and a whole burst collapses into one write.
    deadline: Option<Instant>,
    /// A flusher thread is alive and owns draining `state`.
    armed: bool,
}

/// Atomic `sessions.toml` write + cache refresh. Shared by the immediate and
/// the debounced paths so both keep the same "drop the cache before writing"
/// discipline. Callers hold `sessions_pending`; this takes `sessions_cache`.
fn write_sessions_to(
    path: &Path,
    cache: &Mutex<Option<(FileStamp, SessionState)>>,
    state: &SessionState,
) -> Result<(), StoreError> {
    if let Some(parent) = path.parent() {
        ensure_dir_0700(parent)?;
    }
    let mut cache = cache.lock();
    // Drop first so a failed write can never leave a stale hit behind.
    *cache = None;
    write_toml(path, state)?;
    *cache = FileStamp::of(path).map(|stamp| (stamp, state.clone()));
    Ok(())
}

/// Background half of [`ConfigStore::write_sessions_debounced`]: sleep until
/// the (possibly extended) deadline, then perform the single coalesced write
/// and disarm.
///
/// One short-lived thread per burst rather than a parked worker — no shutdown
/// protocol to get wrong, and an idle raum spawns none at all.
///
/// The pending lock is held across the write so a concurrent submit can
/// neither arm a second flusher nor land its value out of order.
fn spawn_sessions_flusher(
    path: PathBuf,
    cache: Arc<Mutex<Option<(FileStamp, SessionState)>>>,
    pending: Arc<Mutex<PendingSessions>>,
) {
    std::thread::spawn(move || {
        loop {
            let wait = {
                let p = pending.lock();
                p.deadline.map_or(Duration::ZERO, |d| {
                    d.saturating_duration_since(Instant::now())
                })
            };
            if !wait.is_zero() {
                std::thread::sleep(wait);
                continue;
            }
            let mut p = pending.lock();
            if p.deadline.is_some_and(|d| d > Instant::now()) {
                // Extended while we were re-acquiring the lock.
                continue;
            }
            p.deadline = None;
            if let Some(state) = p.state.take()
                && let Err(e) = write_sessions_to(&path, &cache, &state)
            {
                warn!(path = %path.display(), error = %e, "debounced sessions.toml write failed");
            }
            p.armed = false;
            return;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::AgentKind;
    use tempfile::tempdir;

    #[test]
    fn ensure_layout_creates_dirs_and_default_config() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        assert!(dir.path().join("projects").is_dir());
        assert!(dir.path().join("hooks").is_dir());
        assert!(dir.path().join("state").is_dir());
        assert!(dir.path().join("logs").is_dir());
        assert!(dir.path().join("config.toml").is_file());
        assert!(dir.path().join("keybindings.toml").is_file());
    }

    #[test]
    fn round_trips_default_config() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        let cfg = store.read_config().unwrap();
        assert!(!cfg.onboarded);
        assert_eq!(cfg.multiplexer, "tmux");
        assert_eq!(
            cfg.worktree_config.path_pattern,
            "{repo-root}/.raum/{branch-slug}"
        );
    }

    #[test]
    fn project_round_trips() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        let p = ProjectConfig {
            slug: "acme".into(),
            name: "Acme".into(),
            root_path: dir.path().to_path_buf(),
            ..ProjectConfig::default()
        };
        store.write_project(&p).unwrap();
        let back = store.read_project("acme").unwrap().unwrap();
        assert_eq!(back.name, "Acme");
        // No sigil persisted when the user hasn't picked one — it's derived at
        // read-time on the projection layer.
        assert!(back.sigil.is_none());
    }

    #[test]
    fn project_round_trips_with_explicit_sigil() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        let p = ProjectConfig {
            slug: "acme".into(),
            name: "Acme".into(),
            root_path: dir.path().to_path_buf(),
            sigil: Some("Δ".into()),
            ..ProjectConfig::default()
        };
        store.write_project(&p).unwrap();

        // The TOML file should contain the sigil line.
        let toml_raw = std::fs::read_to_string(
            dir.path()
                .join("projects")
                .join("acme")
                .join("project.toml"),
        )
        .unwrap();
        assert!(
            toml_raw.contains("sigil = \"Δ\""),
            "expected sigil in TOML, got:\n{toml_raw}"
        );

        let back = store.read_project("acme").unwrap().unwrap();
        assert_eq!(back.sigil.as_deref(), Some("Δ"));
    }

    #[test]
    fn invalid_slug_rejected() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        assert!(matches!(
            store.read_project("../etc"),
            Err(StoreError::InvalidSlug(_))
        ));
    }

    #[test]
    fn keybindings_round_trip() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        let mut overrides = std::collections::BTreeMap::new();
        overrides.insert("global-search".into(), "Ctrl+K".into());
        let kb = Keybindings { overrides };
        store.write_keybindings(&kb).unwrap();
        let back = store.read_keybindings().unwrap();
        assert_eq!(
            back.overrides.get("global-search").map(String::as_str),
            Some("Ctrl+K")
        );
    }

    #[test]
    fn update_session_harness_id_inserts_then_repairs_changed_id() {
        // The first hook event for a fresh session arrives before the
        // agent-event bridge has had a chance to register the row, so
        // the helper must upsert. Later real hook payloads may repair an
        // earlier bad persisted id.
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();

        // No row exists yet — first call inserts.
        store
            .update_session_harness_id("raum-abc", AgentKind::ClaudeCode, "claude-uuid-1", 100)
            .unwrap();
        assert_eq!(
            store.last_session_harness_id("raum-abc").as_deref(),
            Some("claude-uuid-1"),
        );
        let inserted = store.read_sessions().unwrap();
        let row = inserted
            .sessions
            .iter()
            .find(|s| s.session_id == "raum-abc")
            .expect("upsert should have created the row");
        assert_eq!(row.kind, AgentKind::ClaudeCode);
        assert_eq!(row.created_at_unix_ms, 100);

        // Subsequent calls with a different id overwrite. This lets a real
        // hook payload repair an id guessed by older cwd-newest fallback code.
        store
            .update_session_harness_id(
                "raum-abc",
                AgentKind::ClaudeCode,
                "claude-uuid-DIFFERENT",
                200,
            )
            .unwrap();
        assert_eq!(
            store.last_session_harness_id("raum-abc").as_deref(),
            Some("claude-uuid-DIFFERENT"),
        );
    }

    #[test]
    fn sessions_round_trip() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        let st = SessionState {
            sessions: vec![crate::config::TrackedSession {
                session_id: "raum-abc".into(),
                project_slug: Some("acme".into()),
                worktree_id: None,
                opencode_port: None,
                kind: AgentKind::Shell,
                created_at_unix_ms: 42,
                last_state: None,
                last_state_at_unix_ms: None,
                last_state_acked: false,
                last_prompt_text: None,
                last_prompt_at_unix_ms: None,
                harness_session_id: None,
            }],
        };
        store.write_sessions(&st).unwrap();
        let back = store.read_sessions().unwrap();
        assert_eq!(back.sessions.len(), 1);
    }

    #[test]
    fn sessions_cache_reparses_after_external_edit() {
        // The in-memory cache must never hide a write that came from outside
        // this ConfigStore (file-watcher reload, hand-edit, second process).
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        store
            .update_session_last_state("raum-a", AgentKind::Codex, AgentState::Working, 1)
            .unwrap();
        assert_eq!(store.read_sessions().unwrap().sessions.len(), 1);

        std::fs::write(
            dir.path().join("state").join("sessions.toml"),
            "[[session]]\nsession_id = \"raum-external\"\nkind = \"shell\"\ncreated_at_unix_ms = 7\n",
        )
        .unwrap();

        let back = store.read_sessions().unwrap();
        assert_eq!(back.sessions.len(), 1);
        assert_eq!(back.sessions[0].session_id, "raum-external");
    }

    #[test]
    fn sessions_legacy_file_without_last_state_deserialises() {
        // Existing `state/sessions.toml` files on disk pre-date the
        // `last_state` field. They must keep deserialising to `None` so
        // upgrades don't drop user sessions.
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        let legacy = r#"
[[session]]
session_id = "raum-legacy"
project_slug = "acme"
kind = "shell"
created_at_unix_ms = 1
"#;
        std::fs::write(dir.path().join("state").join("sessions.toml"), legacy).unwrap();
        let back = store.read_sessions().unwrap();
        assert_eq!(back.sessions.len(), 1);
        assert_eq!(back.sessions[0].last_state, None);
        assert_eq!(back.sessions[0].last_state_at_unix_ms, None);
    }

    #[test]
    fn update_session_last_state_upserts_and_overwrites() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();

        // First call creates a minimal row.
        store
            .update_session_last_state("raum-sess", AgentKind::ClaudeCode, AgentState::Working, 100)
            .unwrap();
        assert_eq!(
            store.last_session_state("raum-sess"),
            Some(AgentState::Working)
        );

        // Second call overwrites the state and timestamp.
        store
            .update_session_last_state("raum-sess", AgentKind::ClaudeCode, AgentState::Waiting, 200)
            .unwrap();
        let back = store.read_sessions().unwrap();
        assert_eq!(back.sessions.len(), 1);
        assert_eq!(back.sessions[0].last_state, Some(AgentState::Waiting));
        assert_eq!(back.sessions[0].last_state_at_unix_ms, Some(200));
    }

    #[test]
    fn ack_session_last_state_sets_flag_and_survives_roundtrip() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();

        store
            .update_session_last_state(
                "raum-sess",
                AgentKind::ClaudeCode,
                AgentState::Completed,
                100,
            )
            .unwrap();
        // Fresh transition is unread.
        assert_eq!(
            store.session_state_meta("raum-sess"),
            Some((Some(100), false))
        );

        store.ack_session_last_state("raum-sess").unwrap();
        // Flag flips to true and survives a save/load roundtrip.
        assert_eq!(
            store.session_state_meta("raum-sess"),
            Some((Some(100), true))
        );
        let back = store.read_sessions().unwrap();
        assert!(back.sessions[0].last_state_acked);
    }

    #[test]
    fn ack_session_last_state_on_missing_row_is_noop_ok() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        // Best-effort semantics: acking a session with no tracked row is a
        // silent success, not an error.
        store.ack_session_last_state("raum-nonexistent").unwrap();
        assert!(store.read_sessions().unwrap().sessions.is_empty());
    }

    #[test]
    fn update_session_last_state_resets_acked_flag() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();

        store
            .update_session_last_state(
                "raum-sess",
                AgentKind::ClaudeCode,
                AgentState::Completed,
                100,
            )
            .unwrap();
        store.ack_session_last_state("raum-sess").unwrap();
        assert_eq!(
            store.session_state_meta("raum-sess"),
            Some((Some(100), true))
        );

        // A fresh transition marks the state unread again so it re-surfaces.
        store
            .update_session_last_state("raum-sess", AgentKind::ClaudeCode, AgentState::Working, 200)
            .unwrap();
        assert_eq!(
            store.session_state_meta("raum-sess"),
            Some((Some(200), false))
        );
    }

    #[test]
    fn session_state_meta_returns_none_for_missing_row() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        assert_eq!(store.session_state_meta("raum-nope"), None);
    }

    #[test]
    fn last_state_acked_false_is_omitted_from_serialized_toml() {
        // skip_serializing_if guarantees existing rows don't gain a churn-only
        // `last_state_acked = false` line on upgrade; only an acked row writes
        // the key.
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        store
            .update_session_last_state(
                "raum-sess",
                AgentKind::ClaudeCode,
                AgentState::Completed,
                100,
            )
            .unwrap();

        let path = dir.path().join("state").join("sessions.toml");
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            !raw.contains("last_state_acked"),
            "unacked row must omit last_state_acked, got:\n{raw}"
        );

        store.ack_session_last_state("raum-sess").unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            raw.contains("last_state_acked = true"),
            "acked row must serialize last_state_acked = true, got:\n{raw}"
        );
    }

    #[test]
    fn upsert_tracked_session_inserts_with_full_metadata() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();

        store
            .upsert_tracked_session(
                "raum-sess",
                AgentKind::ClaudeCode,
                Some("acme"),
                Some("wt-main"),
                None,
                42,
            )
            .unwrap();

        let back = store.read_sessions().unwrap();
        assert_eq!(back.sessions.len(), 1);
        let row = &back.sessions[0];
        assert_eq!(row.session_id, "raum-sess");
        assert_eq!(row.kind, AgentKind::ClaudeCode);
        assert_eq!(row.project_slug.as_deref(), Some("acme"));
        assert_eq!(row.worktree_id.as_deref(), Some("wt-main"));
        assert_eq!(row.created_at_unix_ms, 42);
        assert_eq!(row.last_state, None);
    }

    #[test]
    fn upsert_tracked_session_is_metadata_write_once() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();

        // Seed with full metadata.
        store
            .upsert_tracked_session(
                "raum-sess",
                AgentKind::ClaudeCode,
                Some("acme"),
                Some("wt-main"),
                None,
                42,
            )
            .unwrap();

        // A later call with different metadata must NOT overwrite.
        store
            .upsert_tracked_session(
                "raum-sess",
                AgentKind::ClaudeCode,
                Some("other"),
                Some("wt-other"),
                None,
                99,
            )
            .unwrap();

        let back = store.read_sessions().unwrap();
        assert_eq!(back.sessions.len(), 1);
        let row = &back.sessions[0];
        assert_eq!(row.project_slug.as_deref(), Some("acme"));
        assert_eq!(row.worktree_id.as_deref(), Some("wt-main"));
        // `created_at_unix_ms` is insert-only; later calls don't touch it.
        assert_eq!(row.created_at_unix_ms, 42);
    }

    #[test]
    fn upsert_tracked_session_fills_missing_metadata() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();

        // A hook fires before the spawn path persists metadata: row exists
        // with `None` project_slug/worktree_id (via the bridge task path).
        store
            .update_session_last_state("raum-sess", AgentKind::Codex, AgentState::Working, 100)
            .unwrap();

        // Then the spawn path catches up and fills metadata.
        store
            .upsert_tracked_session(
                "raum-sess",
                AgentKind::Codex,
                Some("acme"),
                Some("wt-dev"),
                None,
                50,
            )
            .unwrap();

        let back = store.read_sessions().unwrap();
        assert_eq!(back.sessions.len(), 1);
        let row = &back.sessions[0];
        assert_eq!(row.project_slug.as_deref(), Some("acme"));
        assert_eq!(row.worktree_id.as_deref(), Some("wt-dev"));
        // last_state was already set by `update_session_last_state`, preserved.
        assert_eq!(row.last_state, Some(AgentState::Working));
    }

    #[test]
    fn update_session_last_state_preserves_metadata() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();

        // Spawn path seeds full metadata.
        store
            .upsert_tracked_session(
                "raum-sess",
                AgentKind::OpenCode,
                Some("acme"),
                Some("wt-main"),
                Some(4444),
                42,
            )
            .unwrap();

        // Later hook transitions only know session_id + state; they must
        // not null out project_slug / worktree_id.
        store
            .update_session_last_state("raum-sess", AgentKind::OpenCode, AgentState::Waiting, 200)
            .unwrap();

        let back = store.read_sessions().unwrap();
        assert_eq!(back.sessions.len(), 1);
        let row = &back.sessions[0];
        assert_eq!(row.project_slug.as_deref(), Some("acme"));
        assert_eq!(row.worktree_id.as_deref(), Some("wt-main"));
        assert_eq!(row.opencode_port, Some(4444));
        assert_eq!(row.last_state, Some(AgentState::Waiting));
    }

    #[test]
    fn forget_session_drops_the_row() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        store
            .update_session_last_state("raum-a", AgentKind::Codex, AgentState::Working, 1)
            .unwrap();
        store
            .update_session_last_state("raum-b", AgentKind::Shell, AgentState::Idle, 2)
            .unwrap();
        store.forget_session("raum-a").unwrap();
        let back = store.read_sessions().unwrap();
        assert_eq!(back.sessions.len(), 1);
        assert_eq!(back.sessions[0].session_id, "raum-b");
        // Forgetting a non-existent session is a no-op.
        store.forget_session("not-there").unwrap();
    }

    #[test]
    fn config_and_project_caches_reparse_after_external_edit() {
        // Same contract as the sessions cache: an edit that didn't go through
        // this ConfigStore must still be observed on the next read.
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        assert!(!store.read_config().unwrap().onboarded);

        let mut cfg = store.read_config().unwrap();
        cfg.onboarded = true;
        std::fs::write(
            dir.path().join("config.toml"),
            toml::to_string_pretty(&cfg).unwrap(),
        )
        .unwrap();
        assert!(store.read_config().unwrap().onboarded);

        let p = ProjectConfig {
            slug: "acme".into(),
            name: "Acme".into(),
            root_path: dir.path().to_path_buf(),
            ..ProjectConfig::default()
        };
        store.write_project(&p).unwrap();
        assert_eq!(store.read_project("acme").unwrap().unwrap().name, "Acme");

        let renamed = ProjectConfig {
            name: "Acme Renamed".into(),
            ..p
        };
        std::fs::write(
            dir.path()
                .join("projects")
                .join("acme")
                .join("project.toml"),
            toml::to_string_pretty(&renamed).unwrap(),
        )
        .unwrap();
        assert_eq!(
            store.read_project("acme").unwrap().unwrap().name,
            "Acme Renamed"
        );

        // A deleted project must not keep resolving out of the cache.
        store.delete_project("acme").unwrap();
        assert!(store.read_project("acme").unwrap().is_none());
    }

    #[test]
    fn batch_upsert_and_forget_match_the_single_row_variants() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();

        store
            .upsert_tracked_sessions(&[
                TrackedSessionUpsert {
                    session_id: "raum-a",
                    harness: AgentKind::ClaudeCode,
                    project_slug: Some("acme"),
                    worktree_id: None,
                    opencode_port: None,
                    created_at_unix_ms: 1,
                },
                TrackedSessionUpsert {
                    session_id: "raum-b",
                    harness: AgentKind::Shell,
                    project_slug: None,
                    worktree_id: None,
                    opencode_port: None,
                    created_at_unix_ms: 2,
                },
                // Second row for `raum-a`: write-once metadata still holds
                // inside a single batch.
                TrackedSessionUpsert {
                    session_id: "raum-a",
                    harness: AgentKind::ClaudeCode,
                    project_slug: Some("other"),
                    worktree_id: Some("wt-late"),
                    opencode_port: None,
                    created_at_unix_ms: 9,
                },
            ])
            .unwrap();

        let back = store.read_sessions().unwrap();
        assert_eq!(back.sessions.len(), 2);
        let a = back
            .sessions
            .iter()
            .find(|s| s.session_id == "raum-a")
            .unwrap();
        assert_eq!(a.project_slug.as_deref(), Some("acme"));
        assert_eq!(a.worktree_id.as_deref(), Some("wt-late"));
        assert_eq!(a.created_at_unix_ms, 1);

        store.forget_sessions(&["raum-a", "raum-missing"]).unwrap();
        let back = store.read_sessions().unwrap();
        assert_eq!(back.sessions.len(), 1);
        assert_eq!(back.sessions[0].session_id, "raum-b");
        // All-miss batch is a silent no-op.
        store.forget_sessions(&["nope"]).unwrap();
        assert_eq!(store.read_sessions().unwrap().sessions.len(), 1);
    }

    #[test]
    fn quickfire_history_round_trip() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        let mut hist = QuickfireHistory::default();
        hist.push("ls".into());
        hist.push("git status".into());
        store.write_quickfire_history(&hist).unwrap();
        let back = store.read_quickfire_history().unwrap();
        assert_eq!(
            back.entries,
            vec!["git status".to_string(), "ls".to_string()]
        );
    }

    #[test]
    fn read_config_quarantines_corrupt_file_and_returns_default() {
        // A non-empty, unparsable config.toml must NOT propagate an error
        // (which the frontend turns into a layout-clobbering save-gate open).
        // Instead it degrades to the default and renames the bad file aside.
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();

        let cfg_path = dir.path().join("config.toml");
        std::fs::write(&cfg_path, "this = = not valid toml =").unwrap();

        let cfg = store
            .read_config()
            .expect("corrupt config must degrade, not error");
        // Defaulted, not the corrupt content.
        assert!(!cfg.onboarded);

        // The corrupt file was moved aside with a `.bad-<ts>` suffix, leaving
        // a fresh default file absent (read_config does not rewrite it).
        let salvaged: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .is_some_and(|n| n.starts_with("config.toml.bad-"))
            })
            .collect();
        assert_eq!(salvaged.len(), 1, "expected exactly one quarantined file");
    }

    #[test]
    fn read_active_layout_quarantines_corrupt_file_and_returns_default() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();

        let path = dir.path().join("state").join("active-layout.toml");
        std::fs::write(&path, "cells = [ broken").unwrap();

        let layout = store
            .read_active_layout()
            .expect("corrupt active-layout must degrade, not error");
        assert!(layout.cells.is_empty());

        let salvaged: Vec<_> = std::fs::read_dir(dir.path().join("state"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .is_some_and(|n| n.starts_with("active-layout.toml.bad-"))
            })
            .collect();
        assert_eq!(salvaged.len(), 1, "expected exactly one quarantined layout");
    }

    #[test]
    fn raum_toml_read_parses_and_exposes_unknown() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path().join("cfg"));
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(
            repo.join(".raum.toml"),
            "[hydration]\ncopy = [\".env\"]\nsymlink = []\n\n[future]\nk = 1\n",
        )
        .unwrap();
        let rt = store.read_raum_toml(&repo).unwrap().unwrap();
        assert_eq!(
            rt.hydration.as_ref().unwrap().copy,
            vec![".env".to_string()]
        );
        assert!(rt.unknown.contains_key("future"));
    }

    #[test]
    fn raum_toml_parse_failure_returns_none() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path().join("cfg"));
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(repo.join(".raum.toml"), "not = valid = toml =").unwrap();
        assert!(store.read_raum_toml(&repo).unwrap().is_none());
    }

    // ---- merge_project_with_raum_toml ----

    fn sample_project() -> ProjectConfig {
        ProjectConfig {
            slug: "acme".into(),
            name: "Acme".into(),
            root_path: PathBuf::from("/tmp/acme"),
            hydration: crate::config::HydrationManifest {
                copy: vec![".env".into()],
                symlink: vec![],
            },
            worktree: crate::config::WorktreeConfig {
                path_pattern: "project-pattern/{branch-slug}".into(),
                branch_prefix_mode: crate::config::BranchPrefixMode::None,
                branch_prefix_custom: None,
                ..crate::config::WorktreeConfig::default()
            },
            ..ProjectConfig::default()
        }
    }

    #[test]
    fn merge_no_raum_toml_is_identity() {
        let p = sample_project();
        let eff = merge_project_with_raum_toml(&p, None);
        assert_eq!(eff.worktree.path_pattern, "project-pattern/{branch-slug}");
        assert_eq!(eff.hydration.copy, vec![".env".to_string()]);
        assert!(!eff.has_raum_toml);
    }

    #[test]
    fn merge_raum_toml_overrides_worktree() {
        let p = sample_project();
        let rt = RaumToml {
            worktree: Some(crate::config::WorktreeConfig {
                path_pattern: "raum-pattern/{branch-slug}".into(),
                branch_prefix_mode: crate::config::BranchPrefixMode::Username,
                branch_prefix_custom: None,
                ..crate::config::WorktreeConfig::default()
            }),
            ..RaumToml::default()
        };
        let eff = merge_project_with_raum_toml(&p, Some(&rt));
        assert_eq!(eff.worktree.path_pattern, "raum-pattern/{branch-slug}");
        assert_eq!(
            eff.worktree.branch_prefix_mode,
            crate::config::BranchPrefixMode::Username
        );
        // hydration untouched (raum_toml.hydration was None).
        assert_eq!(eff.hydration.copy, vec![".env".to_string()]);
        assert!(eff.has_raum_toml);
    }

    #[test]
    fn merge_raum_toml_overrides_hydration_only() {
        let p = sample_project();
        let rt = RaumToml {
            hydration: Some(crate::config::HydrationManifest {
                copy: vec![".overridden".into()],
                symlink: vec!["node_modules".into()],
            }),
            ..RaumToml::default()
        };
        let eff = merge_project_with_raum_toml(&p, Some(&rt));
        assert_eq!(eff.hydration.copy, vec![".overridden".to_string()]);
        assert_eq!(eff.hydration.symlink, vec!["node_modules".to_string()]);
        // worktree untouched.
        assert_eq!(eff.worktree.path_pattern, "project-pattern/{branch-slug}");
    }

    // ---- sessions.toml debounce ----

    /// Count the atomic writes that actually reached disk by watching the
    /// file's stat fingerprint change. `atomic_write` renames a fresh inode
    /// over the path every time, so a coalesced burst leaves exactly one bump.
    fn sessions_stamp(dir: &Path) -> Option<(SystemTime, u64)> {
        let meta = std::fs::metadata(dir.join("state").join("sessions.toml")).ok()?;
        Some((meta.modified().ok()?, meta.len()))
    }

    #[test]
    fn last_state_burst_coalesces_into_one_disk_write() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        // Row insert is a lifecycle write — synchronous, and it establishes
        // the file so subsequent field touches can be deferred.
        store
            .update_session_last_state("raum-a", AgentKind::Codex, AgentState::Working, 1)
            .unwrap();
        let before = sessions_stamp(dir.path()).expect("insert must be written through");

        for i in 0..20u64 {
            let state = if i % 2 == 0 {
                AgentState::Waiting
            } else {
                AgentState::Working
            };
            store
                .update_session_last_state("raum-a", AgentKind::Codex, state, 100 + i)
                .unwrap();
        }
        // Nothing on disk yet — the burst is still inside the quiet window.
        assert_eq!(
            sessions_stamp(dir.path()),
            Some(before),
            "a burst of last_state updates must not touch disk while it is hot"
        );
        // …but the cache already reports the newest value.
        assert_eq!(
            store.last_session_state("raum-a"),
            Some(AgentState::Working)
        );

        // Generous margin over SESSIONS_DEBOUNCE for a loaded CI box.
        std::thread::sleep(SESSIONS_DEBOUNCE + Duration::from_millis(750));
        assert_ne!(
            sessions_stamp(dir.path()),
            Some(before),
            "the burst must land on disk once the window goes quiet"
        );
        // Re-read from a cold store: exactly the last value survived.
        let fresh = ConfigStore::new(dir.path());
        let row = &fresh.read_sessions().unwrap().sessions[0];
        assert_eq!(row.last_state, Some(AgentState::Working));
        assert_eq!(row.last_state_at_unix_ms, Some(119));
    }

    #[test]
    fn critical_write_flushes_pending_last_state_first() {
        // Ordering contract: a lifecycle mutation must never land on disk
        // carrying an older `last_state` than memory has already served.
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        store
            .update_session_last_state("raum-a", AgentKind::Codex, AgentState::Working, 1)
            .unwrap();
        store
            .update_session_last_state("raum-a", AgentKind::Codex, AgentState::Completed, 2)
            .unwrap();

        // Critical write while the debounced value is still pending.
        store
            .upsert_tracked_session("raum-b", AgentKind::Shell, Some("acme"), None, None, 3)
            .unwrap();

        let fresh = ConfigStore::new(dir.path());
        let back = fresh.read_sessions().unwrap();
        assert_eq!(back.sessions.len(), 2, "new row must be on disk");
        let a = back
            .sessions
            .iter()
            .find(|s| s.session_id == "raum-a")
            .unwrap();
        assert_eq!(
            a.last_state,
            Some(AgentState::Completed),
            "the pending field update must not be lost or reverted by the lifecycle write"
        );
    }

    #[test]
    fn flush_sessions_writes_pending_immediately() {
        // What the quit-flush path relies on (Contract 1).
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        store
            .update_session_last_state("raum-a", AgentKind::Codex, AgentState::Working, 1)
            .unwrap();
        store
            .update_session_last_state("raum-a", AgentKind::Codex, AgentState::Completed, 2)
            .unwrap();

        store.flush_sessions();

        let fresh = ConfigStore::new(dir.path());
        assert_eq!(
            fresh.read_sessions().unwrap().sessions[0].last_state,
            Some(AgentState::Completed),
        );
        // Idempotent: nothing outstanding, no second write.
        let stamp = sessions_stamp(dir.path());
        store.flush_sessions();
        assert_eq!(sessions_stamp(dir.path()), stamp);
    }

    #[test]
    fn ack_after_debounced_update_is_durable() {
        // `ack_session_last_state` is critical (it silences the attention
        // rail); both the ack and the state it acks must be on disk.
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        store
            .update_session_last_state("raum-a", AgentKind::Codex, AgentState::Working, 1)
            .unwrap();
        store
            .update_session_last_state("raum-a", AgentKind::Codex, AgentState::Completed, 2)
            .unwrap();
        store.ack_session_last_state("raum-a").unwrap();

        let fresh = ConfigStore::new(dir.path());
        let row = &fresh.read_sessions().unwrap().sessions[0];
        assert_eq!(row.last_state, Some(AgentState::Completed));
        assert!(row.last_state_acked);
    }

    #[test]
    fn clearing_an_ack_is_durable_without_waiting_for_the_window() {
        // Inversion guard: the ack is written through immediately, so its
        // clear must be too. Otherwise a crash inside the quiet window leaves
        // disk at acked=true and the next completion never re-surfaces in the
        // attention rail. No sleep here — the cold read *is* the crash.
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        store
            .update_session_last_state("raum-a", AgentKind::Codex, AgentState::Completed, 1)
            .unwrap();
        store.ack_session_last_state("raum-a").unwrap();

        // Agent picks the work back up: fresh transition, ack invalidated.
        store
            .update_session_last_state("raum-a", AgentKind::Codex, AgentState::Working, 2)
            .unwrap();

        let fresh = ConfigStore::new(dir.path());
        let row = &fresh.read_sessions().unwrap().sessions[0];
        assert!(
            !row.last_state_acked,
            "a cleared ack must reach disk immediately, not on the debounce deadline"
        );

        // …while ack-neutral touches still coalesce.
        let before = sessions_stamp(dir.path()).unwrap();
        store
            .update_session_last_state("raum-a", AgentKind::Codex, AgentState::Completed, 3)
            .unwrap();
        assert_eq!(
            sessions_stamp(dir.path()),
            Some(before),
            "an update that changes no ack must stay debounced"
        );
    }
}
