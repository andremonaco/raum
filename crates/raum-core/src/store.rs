//! ConfigStore — atomic TOML reads/writes anchored at `~/.config/raum/`.
//! Fulfils §2.2, §2.3, §2.6 in Wave 1A.
//!
//! Every TOML in raum flows through this module: it guarantees atomic writes
//! (temp-file + rename), 0700 tree perms on Unix, and a single schema version.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::de::DeserializeOwned;
use thiserror::Error;
use tracing::{debug, info, warn};

use crate::config::{
    ActiveLayoutState, Config, EffectiveProjectConfig, Keybindings, LayoutLibrary, ProjectConfig,
    QuickfireHistory, RaumToml, SessionState, WorktreePresetPointer,
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

#[derive(Debug)]
pub struct ConfigStore {
    pub root: PathBuf,
}

impl Default for ConfigStore {
    fn default() -> Self {
        Self {
            root: paths::config_root(),
        }
    }
}

impl ConfigStore {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
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

        // Touch empty layouts.toml / keybindings.toml so users discover the file.
        for name in ["layouts.toml", "keybindings.toml"] {
            let p = self.root.join(name);
            if !p.exists() {
                atomic_write(&p, b"")?;
            }
        }
        Ok(())
    }

    // ---- config.toml --------------------------------------------------------

    pub fn read_config(&self) -> Result<Config, StoreError> {
        let cfg: Config = read_toml_or_default(&self.config_path())?;
        log_unknown_keys("config.toml", &cfg.unknown);
        Ok(cfg)
    }

    pub fn write_config(&self, cfg: &Config) -> Result<(), StoreError> {
        write_toml(&self.config_path(), cfg)
    }

    fn config_path(&self) -> PathBuf {
        self.root.join("config.toml")
    }

    // ---- projects/<slug>/project.toml --------------------------------------

    pub fn read_project(&self, slug: &str) -> Result<Option<ProjectConfig>, StoreError> {
        validate_slug(slug)?;
        let path = self.project_path(slug);
        if !path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(&path)?;
        let project: ProjectConfig = toml::from_str(&raw)?;
        log_unknown_keys(&format!("projects/{slug}/project.toml"), &project.unknown);
        Ok(Some(project))
    }

    pub fn write_project(&self, project: &ProjectConfig) -> Result<(), StoreError> {
        validate_slug(&project.slug)?;
        let dir = self.root.join("projects").join(&project.slug);
        ensure_dir_0700(&dir)?;
        write_toml(&dir.join("project.toml"), project)
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
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        Ok(())
    }

    fn project_path(&self, slug: &str) -> PathBuf {
        self.root.join("projects").join(slug).join("project.toml")
    }

    // ---- layouts.toml -------------------------------------------------------

    pub fn read_layouts(&self) -> Result<LayoutLibrary, StoreError> {
        read_toml_or_default(&self.root.join("layouts.toml"))
    }

    pub fn write_layouts(&self, library: &LayoutLibrary) -> Result<(), StoreError> {
        write_toml(&self.root.join("layouts.toml"), library)
    }

    // ---- keybindings.toml ---------------------------------------------------

    pub fn read_keybindings(&self) -> Result<Keybindings, StoreError> {
        read_toml_or_default(&self.root.join("keybindings.toml"))
    }

    pub fn write_keybindings(&self, kb: &Keybindings) -> Result<(), StoreError> {
        write_toml(&self.root.join("keybindings.toml"), kb)
    }

    // ---- state/sessions.toml ------------------------------------------------

    pub fn read_sessions(&self) -> Result<SessionState, StoreError> {
        read_toml_or_default(&self.root.join("state").join("sessions.toml"))
    }

    pub fn write_sessions(&self, state: &SessionState) -> Result<(), StoreError> {
        ensure_dir_0700(&self.root.join("state"))?;
        write_toml(&self.root.join("state").join("sessions.toml"), state)
    }

    // ---- state/worktree-presets.toml ---------------------------------------

    pub fn read_worktree_presets(&self) -> Result<WorktreePresetPointer, StoreError> {
        read_toml_or_default(&self.root.join("state").join("worktree-presets.toml"))
    }

    pub fn write_worktree_presets(
        &self,
        pointers: &WorktreePresetPointer,
    ) -> Result<(), StoreError> {
        ensure_dir_0700(&self.root.join("state"))?;
        write_toml(
            &self.root.join("state").join("worktree-presets.toml"),
            pointers,
        )
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

fn read_toml_or_default<T: DeserializeOwned + Default>(path: &Path) -> Result<T, StoreError> {
    if !path.exists() {
        return Ok(T::default());
    }
    let raw = std::fs::read_to_string(path)?;
    if raw.trim().is_empty() {
        return Ok(T::default());
    }
    Ok(toml::from_str(&raw)?)
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

/// Atomic write: write to `<path>.<pid>.tmp` and `rename` onto `<path>`.
/// On POSIX `rename(2)` is atomic on the same filesystem, which
/// `~/.config/raum/` is by definition.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("raum.tmp");
    let pid = std::process::id();
    let tmp = path.with_file_name(format!(".{file_name}.{pid}.tmp"));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
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
// DebouncedWriter (§2.3)
// ============================================================================

/// Debounced, atomic writer that coalesces rapid updates of a `T: Serialize`
/// into at most one TOML write per `debounce` quiet window.
///
/// Writers call [`DebouncedWriter::submit`] with a value; the writer waits
/// `debounce` of silence before flushing the most recent value through
/// [`atomic_write`]. Five `submit` calls inside the window collapse into
/// exactly one disk write carrying the last value.
///
/// Backed by a `tokio::sync::mpsc` channel + a single background task. The
/// `T` type parameter is carried for API clarity; serialization to TOML
/// happens inline so `T` never needs to be `Send`.
pub struct DebouncedWriter<T: Serialize> {
    tx: tokio::sync::mpsc::UnboundedSender<Message>,
    _marker: std::marker::PhantomData<fn(T)>,
}

impl<T: Serialize> std::fmt::Debug for DebouncedWriter<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DebouncedWriter")
            .field("type", &std::any::type_name::<T>())
            .finish()
    }
}

impl<T: Serialize> Clone for DebouncedWriter<T> {
    fn clone(&self) -> Self {
        Self {
            tx: self.tx.clone(),
            _marker: std::marker::PhantomData,
        }
    }
}

#[derive(Debug)]
enum Message {
    Submit(String),
    Flush(tokio::sync::oneshot::Sender<()>),
}

impl<T: Serialize> DebouncedWriter<T> {
    /// Create a new writer that serializes `T` to TOML and writes atomically
    /// to `path` with a `debounce` quiet window.
    #[must_use]
    pub fn new(path: PathBuf, debounce: std::time::Duration) -> Self {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();

        tokio::spawn(async move {
            let mut pending: Option<String> = None;
            loop {
                tokio::select! {
                    biased;
                    msg = rx.recv() => {
                        match msg {
                            Some(Message::Submit(raw)) => {
                                pending = Some(raw);
                            }
                            Some(Message::Flush(ack)) => {
                                if let Some(raw) = pending.take() {
                                    if let Err(e) = atomic_write(&path, raw.as_bytes()) {
                                        warn!(path = %path.display(), error = %e, "debounced flush failed");
                                    }
                                }
                                let _ = ack.send(());
                            }
                            None => {
                                if let Some(raw) = pending.take() {
                                    if let Err(e) = atomic_write(&path, raw.as_bytes()) {
                                        warn!(path = %path.display(), error = %e, "debounced final flush failed");
                                    }
                                }
                                break;
                            }
                        }
                    }
                    () = tokio::time::sleep(debounce), if pending.is_some() => {
                        if let Some(raw) = pending.take() {
                            if let Err(e) = atomic_write(&path, raw.as_bytes()) {
                                warn!(path = %path.display(), error = %e, "debounced write failed");
                            }
                        }
                    }
                }
            }
        });

        Self {
            tx,
            _marker: std::marker::PhantomData,
        }
    }

    /// Submit a new value. If more `submit` calls arrive within the debounce
    /// window, only the last value is written.
    pub fn submit(&self, value: &T) -> Result<(), StoreError> {
        let raw = toml::to_string_pretty(value)?;
        // If the receiver has been dropped, the writer task has exited and
        // further submits are no-ops.
        let _ = self.tx.send(Message::Submit(raw));
        Ok(())
    }

    /// Block until any pending value has been flushed. Primarily for tests
    /// and shutdown.
    pub async fn flush(&self) {
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
        if self.tx.send(Message::Flush(ack_tx)).is_err() {
            return;
        }
        let _ = ack_rx.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::AgentKind;
    use crate::config::{LayoutCell, LayoutPreset};
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
        assert!(dir.path().join("layouts.toml").is_file());
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
            "{parent-dir}/{base-folder}-worktrees/{branch-slug}"
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
    fn layouts_round_trip() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        let lib = LayoutLibrary {
            presets: vec![LayoutPreset {
                name: "two-agents".into(),
                cells: vec![LayoutCell {
                    x: 0,
                    y: 0,
                    w: 6,
                    h: 10,
                    kind: AgentKind::ClaudeCode,
                    title: None,
                }],
                created_at: Some(1),
            }],
        };
        store.write_layouts(&lib).unwrap();
        let back = store.read_layouts().unwrap();
        assert_eq!(back.presets.len(), 1);
        assert_eq!(back.presets[0].name, "two-agents");
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
    fn sessions_round_trip() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        let st = SessionState {
            sessions: vec![crate::config::TrackedSession {
                session_id: "raum-abc".into(),
                project_slug: Some("acme".into()),
                worktree_id: None,
                kind: AgentKind::Shell,
                created_at_unix_ms: 42,
            }],
        };
        store.write_sessions(&st).unwrap();
        let back = store.read_sessions().unwrap();
        assert_eq!(back.sessions.len(), 1);
    }

    #[test]
    fn worktree_presets_round_trip() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        store.ensure_layout().unwrap();
        let mut map = std::collections::BTreeMap::new();
        map.insert("acme/main".into(), "two-agents".into());
        let p = WorktreePresetPointer { map };
        store.write_worktree_presets(&p).unwrap();
        let back = store.read_worktree_presets().unwrap();
        assert_eq!(
            back.map.get("acme/main").map(String::as_str),
            Some("two-agents")
        );
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

    // ---- DebouncedWriter ----

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn debounced_writer_coalesces_five_rapid_writes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("out.toml");
        let writer: DebouncedWriter<LayoutLibrary> =
            DebouncedWriter::new(path.clone(), std::time::Duration::from_millis(500));

        // Five submits inside one 500ms quiet window.
        for i in 0..5 {
            let lib = LayoutLibrary {
                presets: vec![LayoutPreset {
                    name: format!("p{i}"),
                    cells: vec![],
                    created_at: None,
                }],
            };
            writer.submit(&lib).unwrap();
        }

        // Advance past the quiet window so the background task flushes once.
        tokio::time::advance(std::time::Duration::from_millis(600)).await;
        writer.flush().await;

        let raw = std::fs::read_to_string(&path).unwrap();
        // Only the last submitted value survives.
        assert!(raw.contains("\"p4\"") || raw.contains("p4"));
        assert!(!raw.contains("\"p3\""));

        // Count temp files; there should be no leftover `.out.toml.*.tmp`.
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(
            entries.len(),
            1,
            "expected exactly one file, found {entries:?}"
        );
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn debounced_writer_flushes_on_drop_via_flush_method() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("out.toml");
        let writer: DebouncedWriter<LayoutLibrary> =
            DebouncedWriter::new(path.clone(), std::time::Duration::from_millis(500));
        let lib = LayoutLibrary::default();
        writer.submit(&lib).unwrap();
        tokio::time::advance(std::time::Duration::from_millis(600)).await;
        writer.flush().await;
        assert!(path.exists());
    }
}
