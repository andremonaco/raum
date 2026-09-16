//! Subprocess wrapper around the `gh` CLI, plus the two cheap preflights that
//! decide whether raum is allowed to spawn it at all.
//!
//! raum never talks to GitHub itself. `docs/privacy.md` promises exactly one
//! outbound call from the app (the updater) and
//! `crates/raum-core/tests/no_outbound_network.rs` enforces it, so every
//! request here is originated by a third-party binary the user installed and
//! authenticated themselves. That is the same deal harness binaries get.
//!
//! Every invocation runs with `current_dir` set to the worktree or repo path —
//! `gh` derives owner/repo and the current branch from the cwd — with the
//! interactive prompts and the update notifier switched off, and under a 20 s
//! timeout. `kill_on_drop` means a timed-out call's process dies with the
//! future instead of lingering.
//!
//! Two preflights gate the whole feature:
//!
//! * [`status`] — is `gh` installed, and which hosts is it logged into? Cached
//!   for 60 s because it costs two subprocesses.
//! * [`resolve`] — what host/owner/repo does this path's `origin` remote point
//!   at, and is that host one of the logged-in ones? Answered from
//!   `git remote get-url origin` alone, so a path on an unauthenticated host
//!   (or no remote at all) never spawns `gh`.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use tracing::{debug, warn};

use super::types::GhStatus;
use crate::git::git_cmd;

/// Hard ceiling for any single `gh` call. A hung call must not pin a poll task
/// forever — the next tick will try again.
const GH_TIMEOUT: Duration = Duration::from_secs(20);

/// How long a [`GhStatus`] snapshot stays valid. Long enough that the poll
/// tasks re-use one answer, short enough that `gh auth login` in a pane shows
/// up within a minute.
const STATUS_TTL: Duration = Duration::from_secs(60);

/// gh's stdout/stderr plus whether it exited zero.
#[derive(Debug, Clone)]
pub(super) struct GhOut {
    pub stdout: String,
    pub stderr: String,
    pub ok: bool,
}

/// Resolved `gh` path. Only *successful* resolutions are cached: a user who
/// installs gh while raum is running gets picked up on the next probe, while
/// the steady state costs no PATH walk.
fn gh_binary() -> Option<PathBuf> {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    if let Some(p) = PATH.get() {
        return Some(p.clone());
    }
    let resolved = which::which("gh").ok()?;
    let _ = PATH.set(resolved.clone());
    Some(resolved)
}

/// Run `gh <args>` in `cwd`. `Err` means the call never produced an exit
/// status (missing binary, spawn failure, timeout); a non-zero exit comes back
/// as `Ok` with `ok == false` so callers can inspect stderr.
pub(super) async fn run(cwd: &Path, args: &[&str]) -> Result<GhOut, String> {
    let bin = gh_binary().ok_or_else(|| "gh not found on PATH".to_string())?;
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .current_dir(cwd)
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .kill_on_drop(true);

    let out = match tokio::time::timeout(GH_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(format!("gh {}: {e}", args.join(" "))),
        Err(_) => {
            return Err(format!(
                "gh {} timed out after {}s",
                args.join(" "),
                GH_TIMEOUT.as_secs()
            ));
        }
    };
    Ok(GhOut {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ok: out.status.success(),
    })
}

/// True for the one non-zero exit that is not an error: `gh pr view` on a
/// branch that has no pull request.
pub(super) fn is_no_pr(out: &GhOut) -> bool {
    !out.ok && out.stderr.to_lowercase().contains("no pull requests found")
}

/// Run `gh <args>` and decode its JSON. `Ok(None)` is the "no pull requests
/// found" case — the normal state of a branch nobody has opened a PR for, not
/// a failure.
pub(super) async fn json<T: DeserializeOwned>(
    cwd: &Path,
    args: &[&str],
) -> Result<Option<T>, String> {
    let out = run(cwd, args).await?;
    if is_no_pr(&out) {
        return Ok(None);
    }
    if !out.ok {
        return Err(if out.stderr.is_empty() {
            format!("gh {} failed", args.join(" "))
        } else {
            out.stderr
        });
    }
    serde_json::from_str(&out.stdout)
        .map(Some)
        .map_err(|e| format!("gh {}: bad JSON: {e}", args.join(" ")))
}

/* ---------- remote detection ---------- */

/// A parsed `origin` remote. `host` is what we match against the hosts `gh` is
/// logged into; `owner`/`repo` build release URLs and feed the deployments
/// GraphQL query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Remote {
    pub host: String,
    pub owner: String,
    pub repo: String,
}

/// Parse the host and `owner/repo` out of a git remote URL. Understands the
/// scp-like form (`git@host:owner/repo.git`), explicit schemes
/// (`ssh://`, `https://`, `git://`, optional user and port) and plain
/// `host/owner/repo`. Anything else — a local path, a single-segment URL —
/// returns `None`, which the callers read as "not a GitHub remote".
pub(super) fn parse_remote_url(url: &str) -> Option<Remote> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    // Strip a scheme if present; remember whether there was one, because only
    // the scp-like form treats ':' as the host/path separator.
    let (rest, scp_allowed) = match url.split_once("://") {
        Some((_scheme, rest)) => (rest, false),
        None => (url, true),
    };
    // Drop any userinfo (`git@`, `user:token@`).
    let rest = match rest.split_once('@') {
        Some((user, after)) if !user.contains('/') => after,
        _ => rest,
    };

    let (host_part, path) = if scp_allowed && let Some((h, p)) = rest.split_once(':') {
        (h, p)
    } else {
        rest.split_once('/')?
    };
    // `ssh://git@host:22/owner/repo` — drop the port.
    let host = match host_part.split_once(':') {
        Some((h, port)) if port.chars().all(|c| c.is_ascii_digit()) => h,
        _ => host_part,
    };
    if host.is_empty() {
        return None;
    }

    let path = path.trim_start_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let path = path.trim_end_matches('/');
    let mut segments = path.split('/').filter(|s| !s.is_empty());
    let owner = segments.next()?;
    let repo = segments.next()?;
    Some(Remote {
        host: host.to_ascii_lowercase(),
        owner: owner.to_string(),
        repo: repo.to_string(),
    })
}

/// `git remote get-url origin` for `path`, parsed. `None` when the path is not
/// a repo, has no `origin`, or `origin` is not a host/owner/repo URL.
pub(super) fn origin_remote(path: &str) -> Option<Remote> {
    let out = git_cmd(path)
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_remote_url(&String::from_utf8_lossy(&out.stdout))
}

/// True when `host` is one of the hosts `gh auth status` reports.
pub(super) fn host_is_authenticated(host: &str, hosts: &[String]) -> bool {
    hosts.iter().any(|h| h.eq_ignore_ascii_case(host))
}

/// The one gate every poll task runs before spawning `gh`: resolve `path`'s
/// `origin` remote and keep it only if `gh` is installed and logged into that
/// host. `None` disables all GitHub chrome for the path.
pub(super) async fn resolve(path: &str) -> Option<Remote> {
    let remote = origin_remote(path)?;
    let st = status().await;
    (st.installed && host_is_authenticated(&remote.host, &st.hosts)).then_some(remote)
}

/* ---------- gh installation + auth status ---------- */

fn status_cache() -> &'static Mutex<Option<(Instant, GhStatus)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, GhStatus)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Installation + auth snapshot, cached for [`STATUS_TTL`].
pub async fn status() -> GhStatus {
    if let Ok(cache) = status_cache().lock()
        && let Some((at, cached)) = cache.as_ref()
        && at.elapsed() < STATUS_TTL
    {
        return cached.clone();
    }
    let fresh = probe_status().await;
    if let Ok(mut cache) = status_cache().lock() {
        *cache = Some((Instant::now(), fresh.clone()));
    }
    fresh
}

async fn probe_status() -> GhStatus {
    let Some(path) = gh_binary() else {
        return GhStatus {
            installed: false,
            error: Some("gh not found on PATH".to_string()),
            ..GhStatus::default()
        };
    };
    // gh resolves the cwd for repo context; `--version` and `auth status` need
    // none, so run them somewhere that always exists.
    let cwd = std::env::temp_dir();
    let version = match run(&cwd, &["--version"]).await {
        Ok(out) => parse_version(&out.stdout),
        Err(e) => {
            warn!(error = %e, "github: gh --version failed");
            None
        }
    };
    let (hosts, error) = match run(&cwd, &["auth", "status"]).await {
        // gh has printed the auth report to stderr in some versions and stdout
        // in others — read both rather than guess.
        Ok(out) => {
            let hosts = parse_auth_hosts(&format!("{}\n{}", out.stdout, out.stderr));
            let error = if hosts.is_empty() {
                Some(if out.stderr.is_empty() {
                    "gh is not logged in to any host".to_string()
                } else {
                    out.stderr
                })
            } else {
                None
            };
            (hosts, error)
        }
        Err(e) => (Vec::new(), Some(e)),
    };
    debug!(?hosts, ?version, "github: gh status probed");
    GhStatus {
        installed: true,
        version,
        path: Some(path.to_string_lossy().into_owned()),
        hosts,
        error,
    }
}

/// `gh version 2.62.0 (2024-11-14)` → `2.62.0`.
pub(super) fn parse_version(raw: &str) -> Option<String> {
    raw.lines()
        .find(|l| l.contains("gh version"))
        .and_then(|l| l.split_whitespace().nth(2))
        .map(str::to_string)
}

/// Pull every host out of `gh auth status`. The line raum keys on is
/// `✓ Logged in to github.com account <user> (keyring)`; older versions say
/// `as <user>` instead of `account <user>`, and both are covered because we
/// only read the token right after "Logged in to".
pub(super) fn parse_auth_hosts(raw: &str) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    for line in raw.lines() {
        let Some((_, rest)) = line.split_once("Logged in to ") else {
            continue;
        };
        let Some(host) = rest.split_whitespace().next() else {
            continue;
        };
        let host = host.trim().to_ascii_lowercase();
        if !host.is_empty() && !hosts.contains(&host) {
            hosts.push(host);
        }
    }
    hosts
}

/// `GhStatus` for the settings prerequisite row and the frontend's feature
/// gate. Never fails — a missing `gh` is a normal, reportable state.
#[tauri::command]
pub async fn github_status() -> Result<GhStatus, String> {
    Ok(status().await)
}
