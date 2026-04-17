//! OpenCode adapter.
//!
//! # Phase 4 migration
//!
//! Historically raum injected a `<raum-managed>` block of hook entries
//! into `$XDG_CONFIG_HOME/opencode/config.json`. OpenCode's architecture
//! does not actually run those entries; the real signal lives on its
//! server-side bus, exposed over `GET /event` (SSE) on the local HTTP
//! server.
//!
//! Phase 4 flips the integration:
//!
//! 1. [`NotificationSetup::plan`] returns a [`SetupPlan`] whose sole
//!    effect is [`SetupAction::RemoveManagedJsonEntries`] — a cleanup
//!    migration that strips any stale raum hook entries left behind by
//!    older raum versions. No new config write is performed; OpenCode's
//!    SSE bus is unconditional.
//! 2. [`HarnessRuntime::channels`] yields an [`OpenCodeSseChannel`] +
//!    the shared silence fallback (silence channel itself is wired by
//!    the runtime supervisor, not in this file).
//! 3. [`HarnessRuntime::replier`] yields an [`HttpReplyReplier`] bound
//!    to the same pending-request map the channel populates.
//!
//! # Port discovery
//!
//! OpenCode picks a random port by default (`--port 0`). Phase 4 uses a
//! three-step discovery chain:
//!
//! 1. `$OPENCODE_PORT` — user / integration override (the plan asked
//!    for this; OpenCode itself does not read the env var today but it
//!    costs nothing to honour it and is forward-compatible).
//! 2. `$XDG_STATE_HOME/opencode/lockfile` (or
//!    `$HOME/.local/state/opencode/lockfile`) — older raum plans
//!    assumed a lockfile here. Current OpenCode does not write one,
//!    but we still look for it so out-of-band tooling (LSP plugins,
//!    shell wrappers) can drop a file containing the port on a single
//!    line.
//! 3. `4096` — the documented default when the user passes
//!    `--port 4096` via the docs' "Starting the server" example
//!    (<https://opencode.ai/docs/server/>).

use std::num::ParseIntError;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::json;
use tracing::{debug, info};

#[allow(deprecated)]
use crate::agent::AgentAdapter;
use crate::agent::{AgentError, AgentKind, SessionId, SpawnOptions, VersionReport, semver_lite};
use crate::config_io::managed_json::{
    self, MARKER_BEGIN, MARKER_KEY, ManagedJsonError, ManagedJsonHooks,
};
use crate::harness::channel::NotificationChannel;
use crate::harness::opencode_reply::HttpReplyReplier;
use crate::harness::opencode_sse::{OpenCodeSseChannel, PendingRequestMap, new_pending_map};
use crate::harness::reply::PermissionReplier;
use crate::harness::setup::{SelftestReport, SetupAction, SetupContext, SetupError, SetupPlan};
use crate::harness::traits::{
    HarnessIdentity, HarnessRuntime, LaunchOverrides, NotificationSetup, SessionSpec,
};

/// Default OpenCode server port when no override is discoverable. Matches
/// the `--port 4096` example in the OpenCode server docs.
pub const DEFAULT_OPENCODE_PORT: u16 = 4096;

/// Environment variable honoured by the port discovery chain. Not a
/// contract OpenCode itself publishes today — kept as the first knob
/// because users / CI routinely need to override the port without
/// editing an on-disk lockfile.
pub const OPENCODE_PORT_ENV: &str = "OPENCODE_PORT";

/// Filename of the OpenCode lockfile inside the XDG state dir.
pub const OPENCODE_LOCKFILE: &str = "lockfile";

#[derive(Debug, Clone)]
pub struct OpenCodeAdapter {
    settings_path_override: Option<PathBuf>,
    port_override: Option<u16>,
    /// Shared between channel + replier so both see the same pending
    /// request id → session id map.
    pending: PendingRequestMap,
}

impl Default for OpenCodeAdapter {
    fn default() -> Self {
        Self {
            settings_path_override: None,
            port_override: None,
            pending: new_pending_map(),
        }
    }
}

impl OpenCodeAdapter {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with_settings_path(path: PathBuf) -> Self {
        Self {
            settings_path_override: Some(path),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn with_port(mut self, port: u16) -> Self {
        self.port_override = Some(port);
        self
    }

    #[must_use]
    pub fn settings_path(&self) -> PathBuf {
        if let Some(p) = &self.settings_path_override {
            return p.clone();
        }
        default_settings_path()
    }

    /// The OpenCode server URL this adapter will connect to.
    #[must_use]
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port())
    }

    fn port(&self) -> u16 {
        self.port_override.unwrap_or_else(|| discover_port(&Env))
    }

    /// Exposed for tests / diagnostics.
    #[must_use]
    pub fn pending_map(&self) -> PendingRequestMap {
        self.pending.clone()
    }
}

fn default_settings_path() -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        let xdg = PathBuf::from(xdg);
        if !xdg.as_os_str().is_empty() {
            return xdg.join("opencode").join("config.json");
        }
    }
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    home.join(".config").join("opencode").join("config.json")
}

/// Abstraction around environment + home-directory lookups so the port
/// discovery chain is unit-testable. Production uses [`Env`]; tests
/// swap in a fake.
trait DiscoveryEnv {
    fn var(&self, key: &str) -> Option<String>;
    fn exists(&self, path: &Path) -> bool;
    fn read_to_string(&self, path: &Path) -> std::io::Result<String>;
}

struct Env;

impl DiscoveryEnv for Env {
    fn var(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }
    fn read_to_string(&self, path: &Path) -> std::io::Result<String> {
        std::fs::read_to_string(path)
    }
}

/// Resolve the OpenCode server port. Public so integration tests can
/// call it with a swapped-in environment.
fn discover_port_inner(env: &dyn DiscoveryEnv) -> u16 {
    if let Some(raw) = env.var(OPENCODE_PORT_ENV)
        && let Ok(p) = parse_port(&raw)
    {
        debug!(target: "opencode", port = p, "discovered port via env");
        return p;
    }

    let lockfile = lockfile_path(env);
    if env.exists(&lockfile)
        && let Ok(raw) = env.read_to_string(&lockfile)
        && let Some(port) = parse_lockfile_port(&raw)
    {
        debug!(target: "opencode", port, "discovered port via lockfile");
        return port;
    }

    debug!(target: "opencode", port = DEFAULT_OPENCODE_PORT, "falling back to default port");
    DEFAULT_OPENCODE_PORT
}

/// Public wrapper used by the adapter. Kept at module scope so other
/// harness code can call it without a dependency on [`OpenCodeAdapter`].
#[must_use]
pub fn discover_port(_ctx: &impl std::any::Any) -> u16 {
    discover_port_inner(&Env)
}

fn lockfile_path(env: &dyn DiscoveryEnv) -> PathBuf {
    if let Some(xdg) = env.var("XDG_STATE_HOME")
        && !xdg.is_empty()
    {
        return PathBuf::from(xdg).join("opencode").join(OPENCODE_LOCKFILE);
    }
    let home = env.var("HOME").unwrap_or_else(|| "/".to_string());
    PathBuf::from(home)
        .join(".local")
        .join("state")
        .join("opencode")
        .join(OPENCODE_LOCKFILE)
}

fn parse_port(raw: &str) -> Result<u16, ParseIntError> {
    raw.trim().parse::<u16>()
}

/// Parse a lockfile's content into a port. The older raum design
/// described the lockfile as a single line with the port as a decimal
/// integer. Current OpenCode does not write one; this parser accepts
/// either a single decimal line, a `port=1234` key-value line, or a
/// JSON object `{"port": 1234}` so we are forgiving if the format
/// drifts.
fn parse_lockfile_port(raw: &str) -> Option<u16> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(p) = trimmed.parse::<u16>() {
        return Some(p);
    }
    // JSON form.
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed)
        && let Some(p) = v.get("port").and_then(|p| p.as_u64())
        && let Ok(p) = u16::try_from(p)
    {
        return Some(p);
    }
    // `key=value` form, accept only the first `port=<n>` we see.
    for line in trimmed.lines() {
        if let Some(rest) = line.trim().strip_prefix("port=")
            && let Ok(p) = rest.trim().parse::<u16>()
        {
            return Some(p);
        }
    }
    None
}

#[async_trait]
#[allow(deprecated)]
impl AgentAdapter for OpenCodeAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::OpenCode
    }

    fn binary_path(&self) -> &'static str {
        "opencode"
    }

    async fn spawn(&self, _opts: SpawnOptions) -> Result<SessionId, AgentError> {
        which::which(self.binary_path()).map_err(|_| AgentError::BinaryMissing {
            binary: self.binary_path().to_string(),
        })?;
        Err(AgentError::Spawn(
            "spawn is owned by the tmux layer; OpenCodeAdapter only validates preconditions".into(),
        ))
    }

    /// Legacy hook install. Phase 4 deprecates this path; adapters that
    /// still go through `AgentAdapter::install_hooks` trigger the
    /// migration cleanup once and then no-op. Kept compiling because
    /// `src-tauri` still invokes it during the deprecation shim window.
    async fn install_hooks(&self, _hooks_dir: &Path) -> Result<(), AgentError> {
        let path = self.settings_path();
        if path.exists() {
            // Strip stale raum entries; ignore I/O errors so a read-only
            // config does not break spawn.
            if let Err(e) = remove_stale_managed_entries(&path) {
                info!(?path, error=%e, "opencode migration cleanup skipped");
            } else {
                info!(
                    ?path,
                    "opencode settings.json: raum entries removed (Phase 4 migration)"
                );
            }
        }
        Ok(())
    }

    fn supports_native_events(&self) -> bool {
        true
    }

    async fn detect_version(&self) -> Result<VersionReport, AgentError> {
        super::claude_code::run_version(
            <Self as AgentAdapter>::binary_path(self),
            &<Self as AgentAdapter>::minimum_version(self),
        )
        .await
    }

    fn minimum_version(&self) -> semver_lite::Version {
        semver_lite::Version {
            major: 0,
            minor: 1,
            patch: 0,
        }
    }
}

// ---- New trait split (Phase 2/4) -------------------------------------------

#[async_trait]
impl HarnessIdentity for OpenCodeAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::OpenCode
    }
    fn binary(&self) -> &'static str {
        "opencode"
    }
    fn minimum_version(&self) -> semver_lite::Version {
        semver_lite::Version {
            major: 0,
            minor: 1,
            patch: 0,
        }
    }
    async fn detect_version(&self) -> Result<VersionReport, AgentError> {
        super::claude_code::run_version(
            <Self as HarnessIdentity>::binary(self),
            &<Self as HarnessIdentity>::minimum_version(self),
        )
        .await
    }
}

#[async_trait]
impl NotificationSetup for OpenCodeAdapter {
    /// Phase 4 plan: no config-file write. Only a migration cleanup
    /// action that strips any stale `<raum-managed>` entries from
    /// `config.json`.
    async fn plan(&self, _ctx: &SetupContext) -> Result<SetupPlan, SetupError> {
        let mut plan = SetupPlan::new(AgentKind::OpenCode);
        plan.push(SetupAction::AssertBinary {
            name: "opencode".into(),
        });
        plan.push(SetupAction::RemoveManagedJsonEntries {
            path: self.settings_path(),
        });
        Ok(plan)
    }

    /// Phase 4 selftest: fire a cheap GET against the OpenCode HTTP
    /// server. A connection refusal reports `pending` (OpenCode not
    /// running yet) — **not** an error; the Phase 5 UI will render
    /// this as a "waiting for server" banner. Any other outcome
    /// (2xx / 4xx / 5xx) is treated as "reachable" because the
    /// server is clearly listening.
    async fn selftest(&self, _ctx: &SetupContext) -> SelftestReport {
        let started = Instant::now();
        let url = format!("{}/global/health", self.base_url());
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(500))
            .build();
        let Ok(client) = client else {
            return SelftestReport::failed(
                AgentKind::OpenCode,
                "reqwest client build failed",
                started.elapsed().as_millis() as u64,
            );
        };
        match client.get(&url).send().await {
            Ok(_) => SelftestReport::ok(
                AgentKind::OpenCode,
                format!("server reachable at {url}"),
                started.elapsed().as_millis() as u64,
            ),
            Err(e) if e.is_timeout() || e.is_connect() => SelftestReport::ok(
                AgentKind::OpenCode,
                "opencode-server-not-running",
                started.elapsed().as_millis() as u64,
            ),
            Err(e) => SelftestReport::failed(
                AgentKind::OpenCode,
                format!("transport error: {e}"),
                started.elapsed().as_millis() as u64,
            ),
        }
    }
}

impl HarnessRuntime for OpenCodeAdapter {
    fn channels(&self, session: &SessionSpec) -> Vec<Box<dyn NotificationChannel>> {
        // The `SilenceChannel` fallback is wired by the runtime
        // supervisor (out of scope for Phase 4 — see the plan's Module
        // Layout section). Phase 4 contributes just the SSE channel.
        vec![Box::new(OpenCodeSseChannel::new(
            self.base_url(),
            self.pending.clone(),
            session.session_id.clone(),
        ))]
    }

    fn replier(&self, _session: &SessionSpec) -> Option<Box<dyn PermissionReplier>> {
        Some(Box::new(HttpReplyReplier::new(
            self.base_url(),
            self.pending.clone(),
        )))
    }

    fn launch_overrides(&self) -> LaunchOverrides {
        LaunchOverrides::default()
    }
}

/// Legacy install helper. Kept so existing callers / tests can exercise
/// the old write-hooks-into-config path while they migrate; new code
/// should go through [`NotificationSetup::plan`] instead.
#[allow(dead_code)]
pub fn install_opencode_hooks(path: &Path, script: &Path) -> std::io::Result<()> {
    managed_json::apply_managed_hooks(&ManagedJsonHooks {
        path,
        events: &["Notification", "Stop", "UserPromptSubmit"],
        make_entry: &|event| {
            json!({
                MARKER_KEY: MARKER_BEGIN,
                "_raum_event": event,
                "matcher": ".*",
                "hooks": [
                    { "type": "command", "command": format!("{} {}", script.display(), event) }
                ],
            })
        },
    })
    .map_err(managed_json_error_to_io)
}

/// Remove every `<raum-managed>` entry from the OpenCode `config.json`
/// at `path`. Returns `Ok(())` when the file is missing or does not
/// contain any raum entries.
fn remove_stale_managed_entries(path: &Path) -> std::io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(path)?;
    if raw.trim().is_empty() {
        return Ok(());
    }
    let mut root: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        // Leave unparsable config alone — user content.
        Err(_) => return Ok(()),
    };
    let mut changed = false;
    if let Some(hooks) = root
        .as_object_mut()
        .and_then(|o| o.get_mut("hooks"))
        .and_then(|v| v.as_object_mut())
    {
        for (_event, arr) in hooks.iter_mut() {
            if let Some(list) = arr.as_array_mut() {
                let before = list.len();
                list.retain(|v| !managed_json::is_raum_managed(v));
                if list.len() != before {
                    changed = true;
                }
            }
        }
    }
    if !changed {
        return Ok(());
    }
    let serialized = serde_json::to_string_pretty(&root)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    managed_json::atomic_write(path, serialized.as_bytes())?;
    Ok(())
}

fn managed_json_error_to_io(e: ManagedJsonError) -> std::io::Error {
    match e {
        ManagedJsonError::Io(err) => err,
        ManagedJsonError::InvalidJson(err) => std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("config.json is not valid JSON: {err}"),
        ),
        ManagedJsonError::Serialize(err) => std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("serialize config.json failed: {err}"),
        ),
    }
}

#[cfg(test)]
#[allow(deprecated)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::collections::HashMap;
    use tempfile::tempdir;

    // ---------- Port discovery ------------------------------------------------

    struct FakeEnv {
        vars: HashMap<String, String>,
        files: HashMap<PathBuf, String>,
    }

    impl DiscoveryEnv for FakeEnv {
        fn var(&self, key: &str) -> Option<String> {
            self.vars.get(key).cloned()
        }
        fn exists(&self, path: &Path) -> bool {
            self.files.contains_key(path)
        }
        fn read_to_string(&self, path: &Path) -> std::io::Result<String> {
            self.files.get(path).cloned().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("no {}", path.display()),
                )
            })
        }
    }

    fn fake(vars: &[(&str, &str)], files: &[(PathBuf, &str)]) -> FakeEnv {
        FakeEnv {
            vars: vars
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
            files: files
                .iter()
                .map(|(k, v)| (k.clone(), (*v).to_string()))
                .collect(),
        }
    }

    #[test]
    fn discover_port_prefers_env() {
        let env = fake(&[(OPENCODE_PORT_ENV, "5123")], &[]);
        assert_eq!(discover_port_inner(&env), 5123);
    }

    #[test]
    fn discover_port_falls_through_invalid_env_to_lockfile() {
        let lock = PathBuf::from("/xdg/state/opencode/lockfile");
        let env = fake(
            &[
                (OPENCODE_PORT_ENV, "not-a-port"),
                ("XDG_STATE_HOME", "/xdg/state"),
            ],
            &[(lock, "4711")],
        );
        assert_eq!(discover_port_inner(&env), 4711);
    }

    #[test]
    fn discover_port_reads_xdg_state_lockfile_plain() {
        let lock = PathBuf::from("/xdg/state/opencode/lockfile");
        let env = fake(&[("XDG_STATE_HOME", "/xdg/state")], &[(lock, "5678\n")]);
        assert_eq!(discover_port_inner(&env), 5678);
    }

    #[test]
    fn discover_port_reads_lockfile_json() {
        let lock = PathBuf::from("/xdg/state/opencode/lockfile");
        let env = fake(
            &[("XDG_STATE_HOME", "/xdg/state")],
            &[(lock, r#"{"port": 9090, "pid": 42}"#)],
        );
        assert_eq!(discover_port_inner(&env), 9090);
    }

    #[test]
    fn discover_port_reads_lockfile_key_value() {
        let lock = PathBuf::from("/xdg/state/opencode/lockfile");
        let env = fake(
            &[("XDG_STATE_HOME", "/xdg/state")],
            &[(lock, "pid=42\nport=1234\n")],
        );
        assert_eq!(discover_port_inner(&env), 1234);
    }

    #[test]
    fn discover_port_home_fallback_lockfile() {
        // No XDG_STATE_HOME → use $HOME/.local/state/opencode/lockfile.
        let lock = PathBuf::from("/home/alice/.local/state/opencode/lockfile");
        let env = fake(&[("HOME", "/home/alice")], &[(lock, "2222")]);
        assert_eq!(discover_port_inner(&env), 2222);
    }

    #[test]
    fn discover_port_defaults_when_nothing_found() {
        let env = fake(&[], &[]);
        assert_eq!(discover_port_inner(&env), DEFAULT_OPENCODE_PORT);
    }

    // ---------- Migration cleanup --------------------------------------------

    #[tokio::test]
    async fn migration_cleanup_removes_raum_entries() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join("config.json");
        let original = json!({
            "provider": { "openai": { "model": "gpt-4" } },
            "hooks": {
                "Notification": [
                    { "matcher": "user-x", "hooks": [] },
                    { MARKER_KEY: MARKER_BEGIN, "matcher": ".*", "hooks": [] }
                ]
            }
        });
        std::fs::write(&settings, serde_json::to_string_pretty(&original).unwrap()).unwrap();
        let adapter = OpenCodeAdapter::with_settings_path(settings.clone());
        adapter.install_hooks(dir.path()).await.unwrap();
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(
            parsed["provider"]["openai"]["model"].as_str().unwrap(),
            "gpt-4"
        );
        let notif = parsed["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 1);
        assert_eq!(notif[0]["matcher"].as_str().unwrap(), "user-x");
    }

    #[tokio::test]
    async fn migration_cleanup_noop_when_config_missing() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join("config.json");
        let adapter = OpenCodeAdapter::with_settings_path(settings.clone());
        // No panic, no file created.
        adapter.install_hooks(dir.path()).await.unwrap();
        assert!(!settings.exists());
    }

    #[tokio::test]
    async fn plan_is_remove_managed_only() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join("config.json");
        let adapter = OpenCodeAdapter::with_settings_path(settings.clone());
        let ctx = SetupContext::new(
            dir.path().to_path_buf(),
            dir.path().join("events.sock"),
            "demo",
        );
        let plan = <OpenCodeAdapter as NotificationSetup>::plan(&adapter, &ctx)
            .await
            .unwrap();
        // AssertBinary + RemoveManagedJsonEntries — no WriteJson.
        assert!(plan.actions.iter().any(
            |a| matches!(a, SetupAction::RemoveManagedJsonEntries { path } if path == &settings)
        ));
        assert!(
            !plan
                .actions
                .iter()
                .any(|a| matches!(a, SetupAction::WriteJson { .. }))
        );
    }

    // ---------- Selftest -----------------------------------------------------

    #[tokio::test]
    async fn selftest_reports_pending_when_server_down() {
        let dir = tempdir().unwrap();
        let adapter = OpenCodeAdapter::default().with_port(1); // unroutable
        let ctx = SetupContext::new(
            dir.path().to_path_buf(),
            dir.path().join("events.sock"),
            "demo",
        );
        let report = <OpenCodeAdapter as NotificationSetup>::selftest(&adapter, &ctx).await;
        assert!(report.ok, "pending ≠ error: {:?}", report);
        assert!(
            report.detail.contains("opencode-server-not-running"),
            "unexpected detail: {}",
            report.detail
        );
    }

    #[tokio::test]
    async fn selftest_reports_ok_when_server_reachable() {
        use wiremock::matchers::method;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "healthy": true,
                "version": "0.0.0"
            })))
            .mount(&server)
            .await;
        let uri = server.uri();
        // Extract the port wiremock bound to.
        let port: u16 = uri
            .rsplit(':')
            .next()
            .and_then(|p| p.parse().ok())
            .expect("port");
        let dir = tempdir().unwrap();
        let adapter = OpenCodeAdapter::default().with_port(port);
        let ctx = SetupContext::new(
            dir.path().to_path_buf(),
            dir.path().join("events.sock"),
            "demo",
        );
        let report = <OpenCodeAdapter as NotificationSetup>::selftest(&adapter, &ctx).await;
        assert!(report.ok);
        assert!(
            report.detail.contains("server reachable"),
            "unexpected: {}",
            report.detail
        );
    }

    // ---------- Legacy install path + misc -----------------------------------

    #[test]
    fn default_settings_path_ends_with_opencode_config_json() {
        let p = default_settings_path();
        assert!(
            p.ends_with("opencode/config.json"),
            "unexpected path: {}",
            p.display()
        );
    }

    #[test]
    fn base_url_honours_port_override() {
        let a = OpenCodeAdapter::default().with_port(1234);
        assert_eq!(a.base_url(), "http://127.0.0.1:1234");
    }
}
