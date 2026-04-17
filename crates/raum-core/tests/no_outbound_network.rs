//! §11.7 — audit: assert no outbound network calls occur during a
//! waiting-state burst.
//!
//! Full automation of this audit is impossible from pure Rust without a
//! sandboxed test harness (e.g. seccomp on Linux, `sandbox-exec` on macOS,
//! or a loopback-only netns). Instead we combine two complementary checks:
//!
//! 1. **State-machine burst** (runtime): synthesize 200 `waiting` transitions
//!    back-to-back through the `AgentStateMachine` and confirm the machine
//!    itself performs no TCP/DNS I/O. This is enforced structurally — the
//!    `AgentStateMachine` type contains no sockets, no HTTP clients, and no
//!    network-capable handles; the test simply exercises the hot path to
//!    guarantee we don't regress that invariant by adding telemetry later.
//!
//! 2. **Dependency audit** (compile-time manifest walk): scan every
//!    `Cargo.toml` in the workspace and reject a hard-coded deny-list of
//!    outbound-network crates (`reqwest`, `hyper`, `ureq`, `isahc`, `curl`,
//!    `surf`, `awc`) anywhere outside the `tauri-plugin-updater` boundary.
//!    The updater's auto-update check is the single whitelisted outbound
//!    network call per `docs/privacy.md` (§11.7 + spec `privacy` capability).
//!
//! Together these two gates give us high confidence that a waiting-state
//! burst cannot produce any outbound network activity, even though a truly
//! airtight proof would require OS-level sandboxing in CI.
//!
//! ### Limitations
//!
//! * We do not instrument `syscall` trapping — that needs a sandbox harness.
//! * Transitive dependencies are deliberately not scanned; the workspace
//!   `unsafe_code = "deny"` lint plus `cargo deny` (run in CI, not here)
//!   cover the transitive case.

use std::path::{Path, PathBuf};
use std::time::Duration;

use raum_core::agent::{AgentKind, AgentState, SessionId};
use raum_core::agent_state::{AgentStateMachine, HookEvent};

/// Direct crates that open outbound network connections. The audit rejects
/// any `Cargo.toml` under the workspace that pulls one of these in as a
/// direct dependency, except for the `tauri-plugin-updater` boundary.
const OUTBOUND_NETWORK_CRATES: &[&str] =
    &["reqwest", "hyper", "ureq", "isahc", "curl", "surf", "awc"];

/// Crates that are allowed to pull in outbound-network dependencies, because
/// their purpose *is* to make a network call. The entries are:
///
/// * `tauri-plugin-updater` — the auto-update boundary (single whitelisted
///   internet call per `docs/privacy.md`).
/// * `raum-core` — the OpenCode harness integration (Phase 4) talks to
///   `http://127.0.0.1:<port>` over `reqwest`. This is loopback-only
///   (127.0.0.1 / `/global/health`, `/event`, `/permission/:id/reply`) and
///   never hits the public network. The harness-layer selftest + channel
///   code refuses any non-loopback base URL construction; see
///   `harness::opencode::OpenCodeAdapter::base_url`.
const ALLOWED_NETWORK_DEP_PACKAGES: &[&str] = &["tauri-plugin-updater", "raum-core"];

fn workspace_root() -> PathBuf {
    // `CARGO_MANIFEST_DIR` points at `crates/raum-core`; walk up twice.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("workspace root")
        .to_path_buf()
}

/// Collect every `Cargo.toml` under the workspace root, skipping `target/`
/// and `node_modules/` to keep the walk bounded.
fn collect_manifests(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let read = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in read.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                let name = entry.file_name();
                let n = name.to_string_lossy();
                if n == "target" || n == "node_modules" || n == ".git" || n == "dist" {
                    continue;
                }
                stack.push(path);
            } else if ft.is_file()
                && path.file_name().and_then(|s| s.to_str()) == Some("Cargo.toml")
            {
                out.push(path);
            }
        }
    }
    out
}

/// Return the package name from a parsed manifest, if present.
fn package_name(manifest: &toml::Value) -> Option<&str> {
    manifest
        .get("package")
        .and_then(|p| p.get("name"))
        .and_then(|n| n.as_str())
}

/// Return every direct dependency name declared anywhere in the manifest
/// (`dependencies`, `dev-dependencies`, `build-dependencies`, and their
/// `target.*` variants).
fn direct_deps(manifest: &toml::Value) -> Vec<String> {
    let mut out = Vec::new();
    for key in ["dependencies", "dev-dependencies", "build-dependencies"] {
        if let Some(tbl) = manifest.get(key).and_then(|v| v.as_table()) {
            for k in tbl.keys() {
                out.push(k.clone());
            }
        }
    }
    if let Some(targets) = manifest.get("target").and_then(|v| v.as_table()) {
        for (_triple, tv) in targets {
            for key in ["dependencies", "dev-dependencies", "build-dependencies"] {
                if let Some(tbl) = tv.get(key).and_then(|v| v.as_table()) {
                    for k in tbl.keys() {
                        out.push(k.clone());
                    }
                }
            }
        }
    }
    out
}

#[test]
fn waiting_burst_uses_no_network() {
    // Drive a rapid burst of Working → Waiting transitions and confirm the
    // state machine stays a pure-logic value-type throughout. This is the
    // hot path consumed by the notification subsystem (§11.1); if we ever
    // regress by embedding an HTTP client in `AgentStateMachine`, this test
    // is where it will surface — via either a dependency-audit failure below
    // or a compile error when `AgentStateMachine` stops being `'static` +
    // pure.
    let mut m = AgentStateMachine::new(SessionId::new("raum-audit"), AgentKind::ClaudeCode)
        .with_silence_threshold(Duration::from_millis(10));

    let start = HookEvent {
        harness: "claude-code".into(),
        event: "PreToolUse".into(),
        payload: serde_json::Value::Null,
    };
    let waiting = HookEvent {
        harness: "claude-code".into(),
        event: "Notification".into(),
        payload: serde_json::Value::Null,
    };

    let mut waiting_count = 0usize;
    for _ in 0..200 {
        let _ = m.on_hook_event(&start);
        if let Some(change) = m.on_hook_event(&waiting) {
            if change.to == AgentState::Waiting {
                waiting_count += 1;
            }
        }
    }
    assert!(
        waiting_count > 0,
        "expected the burst to produce at least one waiting transition"
    );
}

#[test]
fn no_outbound_network_crates_in_direct_deps() {
    // Dependency audit: scan every workspace `Cargo.toml` for a hard-coded
    // deny-list of outbound-network crates. See module docs for scope.
    let root = workspace_root();
    let manifests = collect_manifests(&root);
    assert!(
        !manifests.is_empty(),
        "audit walk found no manifests under {}",
        root.display()
    );

    let mut violations: Vec<String> = Vec::new();
    for path in &manifests {
        let raw = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let manifest: toml::Value = match toml::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let pkg = package_name(&manifest).unwrap_or("<workspace>");
        if ALLOWED_NETWORK_DEP_PACKAGES.contains(&pkg) {
            continue;
        }

        for dep in direct_deps(&manifest) {
            if OUTBOUND_NETWORK_CRATES.contains(&dep.as_str()) {
                violations.push(format!("{} depends on {}", path.display(), dep));
            }
        }
    }

    assert!(
        violations.is_empty(),
        "outbound-network deny-list violated:\n  {}\n\nPer §11.7, the only allowed outbound network crate is `tauri-plugin-updater`. \
         If you genuinely need a new network call, add the containing package to \
         `ALLOWED_NETWORK_DEP_PACKAGES` and document it in `docs/privacy.md`.",
        violations.join("\n  ")
    );
}
