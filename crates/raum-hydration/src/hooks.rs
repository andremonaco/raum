//! Worktree lifecycle hooks (§6.3+) — user-defined executable scripts that
//! run immediately before `git worktree add` and immediately after hydration
//! completes. See the [`WorktreeHooks`](raum_core::config::WorktreeHooks)
//! config struct for the user-facing contract.
//!
//! The executor is intentionally sync: the surrounding Tauri command path for
//! worktree creation is already blocking (it calls [`apply_hydration`] directly)
//! so we avoid dragging an async runtime into this crate. The timeout is
//! implemented with a background reader thread + `try_wait` poll loop so that
//! we can still kill runaway children without relying on tokio.
//!
//! [`apply_hydration`]: crate::hydrate::apply_hydration

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use thiserror::Error;
use tracing::{debug, warn};

/// Maximum captured bytes per stream (stdout / stderr) returned to the caller.
/// Beyond this, we keep the head of the buffer so the error surface stays
/// bounded; users can still stream everything to a log file from the script.
pub const HOOK_OUTPUT_TAIL_BYTES: usize = 8 * 1024;

/// Which phase a hook is running for. Surfaced to the script as `$RAUM_PHASE`
/// so a single file can branch on `pre-create` / `post-create` if the user
/// prefers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookPhase {
    PreCreate,
    PostCreate,
}

impl HookPhase {
    #[must_use]
    pub fn as_env_value(self) -> &'static str {
        match self {
            Self::PreCreate => "pre-create",
            Self::PostCreate => "post-create",
        }
    }
}

/// Per-invocation context passed to the hook script as env vars.
#[derive(Debug, Clone)]
pub struct HookContext<'a> {
    pub project_slug: &'a str,
    pub project_root: &'a Path,
    pub worktree_path: &'a Path,
    pub branch: &'a str,
}

#[derive(Debug, Clone)]
pub struct HookReport {
    pub phase: HookPhase,
    pub duration_ms: u64,
    pub stdout_tail: String,
    pub stderr_tail: String,
}

#[derive(Debug, Error)]
pub enum HookError {
    #[error("hook script `{path}` not found")]
    NotFound { path: PathBuf },
    #[error("failed to spawn hook `{path}`: {source}")]
    Spawn {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("hook `{path}` exited with code {code:?}\n--- stderr tail ---\n{stderr_tail}")]
    Failed {
        path: PathBuf,
        code: Option<i32>,
        stdout_tail: String,
        stderr_tail: String,
    },
    #[error("hook `{path}` timed out after {timeout_secs}s and was killed")]
    Timeout {
        path: PathBuf,
        timeout_secs: u32,
        stdout_tail: String,
        stderr_tail: String,
    },
    #[error("io waiting on hook `{path}`: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Resolve a user-provided hook path against the project root.
///
/// Absolute paths pass through unchanged; relative paths are joined onto the
/// project root so a repo-local `scripts/setup.sh` "just works" regardless of
/// where raum was launched from.
#[must_use]
pub fn resolve_hook_path(project_root: &Path, raw: &str) -> PathBuf {
    let candidate = Path::new(raw);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        project_root.join(candidate)
    }
}

/// Execute a hook script, blocking until it exits, times out, or fails.
///
/// * cwd for `PreCreate` is the project root (the worktree does not exist yet).
/// * cwd for `PostCreate` is the freshly hydrated worktree.
/// * `timeout_secs == 0` disables the timeout.
pub fn run_hook(
    phase: HookPhase,
    script: &Path,
    ctx: &HookContext<'_>,
    timeout_secs: u32,
) -> Result<HookReport, HookError> {
    if !script.exists() {
        return Err(HookError::NotFound {
            path: script.to_path_buf(),
        });
    }

    let cwd = match phase {
        HookPhase::PreCreate => ctx.project_root,
        HookPhase::PostCreate => ctx.worktree_path,
    };

    let mut cmd = Command::new(script);
    cmd.current_dir(cwd)
        .env("RAUM_PHASE", phase.as_env_value())
        .env("RAUM_PROJECT_SLUG", ctx.project_slug)
        .env("RAUM_PROJECT_ROOT", ctx.project_root)
        .env("RAUM_WORKTREE_PATH", ctx.worktree_path)
        .env("RAUM_BRANCH", ctx.branch)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    debug!(?phase, ?script, "spawning worktree hook");
    let mut child = cmd.spawn().map_err(|e| HookError::Spawn {
        path: script.to_path_buf(),
        source: e,
    })?;

    let stdout_reader = spawn_capture(child.stdout.take());
    let stderr_reader = spawn_capture(child.stderr.take());

    let started = Instant::now();
    let outcome = wait_with_timeout(&mut child, timeout_secs);

    let stdout_tail = join_reader(stdout_reader);
    let stderr_tail = join_reader(stderr_reader);

    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

    match outcome {
        WaitOutcome::Exited(status) => {
            if status.success() {
                Ok(HookReport {
                    phase,
                    duration_ms,
                    stdout_tail,
                    stderr_tail,
                })
            } else {
                warn!(?script, code = ?status.code(), "worktree hook failed");
                Err(HookError::Failed {
                    path: script.to_path_buf(),
                    code: status.code(),
                    stdout_tail,
                    stderr_tail,
                })
            }
        }
        WaitOutcome::TimedOut => {
            warn!(?script, timeout_secs, "worktree hook timed out; killed");
            Err(HookError::Timeout {
                path: script.to_path_buf(),
                timeout_secs,
                stdout_tail,
                stderr_tail,
            })
        }
        WaitOutcome::Io(err) => Err(HookError::Io {
            path: script.to_path_buf(),
            source: err,
        }),
    }
}

enum WaitOutcome {
    Exited(std::process::ExitStatus),
    TimedOut,
    Io(std::io::Error),
}

fn wait_with_timeout(child: &mut Child, timeout_secs: u32) -> WaitOutcome {
    if timeout_secs == 0 {
        return match child.wait() {
            Ok(status) => WaitOutcome::Exited(status),
            Err(e) => WaitOutcome::Io(e),
        };
    }

    let deadline = Instant::now() + Duration::from_secs(u64::from(timeout_secs));
    let poll = Duration::from_millis(100);

    loop {
        match child.try_wait() {
            Ok(Some(status)) => return WaitOutcome::Exited(status),
            Ok(None) => {}
            Err(e) => return WaitOutcome::Io(e),
        }

        if Instant::now() >= deadline {
            // Best-effort kill; if the child has already exited between the
            // last poll and now, we pick that up on the next try_wait.
            let _ = child.kill();
            let _ = child.wait();
            return WaitOutcome::TimedOut;
        }

        thread::sleep(poll);
    }
}

fn spawn_capture<R>(stream: Option<R>) -> Option<thread::JoinHandle<String>>
where
    R: Read + Send + 'static,
{
    let mut reader = stream?;
    Some(thread::spawn(move || {
        let mut buf = Vec::with_capacity(4096);
        // Ignore read errors — the process may have been killed and we still
        // want whatever we've captured so far.
        let _ = reader.read_to_end(&mut buf);
        truncate_tail(&buf)
    }))
}

fn join_reader(handle: Option<thread::JoinHandle<String>>) -> String {
    handle.and_then(|h| h.join().ok()).unwrap_or_default()
}

fn truncate_tail(buf: &[u8]) -> String {
    let (slice, prefix) = if buf.len() > HOOK_OUTPUT_TAIL_BYTES {
        let start = buf.len() - HOOK_OUTPUT_TAIL_BYTES;
        (&buf[start..], "…(truncated)…\n")
    } else {
        (buf, "")
    };
    let rendered = String::from_utf8_lossy(slice);
    if prefix.is_empty() {
        rendered.into_owned()
    } else {
        format!("{prefix}{rendered}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, body).unwrap();
        let mut perm = fs::metadata(&path).unwrap().permissions();
        perm.set_mode(0o755);
        fs::set_permissions(&path, perm).unwrap();
        path
    }

    /// Retry `run_hook` on Linux's `ETXTBSY` ("Text file busy"). When the
    /// hydration test suite runs in parallel with the rest of the workspace
    /// on Linux CI, one test's `fork()` can inherit another test's just-
    /// written script fd before the parent closes it; the subsequent
    /// `execve` of that script races the still-open write fd and fails
    /// with ETXTBSY. The file is valid — retry a few times with a small
    /// backoff gives the forked child a chance to finish its own exec and
    /// release the inherited fd.
    fn run_hook_retry(
        phase: HookPhase,
        script: &Path,
        ctx: &HookContext<'_>,
        timeout_secs: u32,
    ) -> Result<HookReport, HookError> {
        for attempt in 0..5 {
            match run_hook(phase, script, ctx, timeout_secs) {
                Err(HookError::Spawn { source, .. })
                    if source.kind() == std::io::ErrorKind::ExecutableFileBusy =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(50 * (attempt + 1)));
                }
                other => return other,
            }
        }
        run_hook(phase, script, ctx, timeout_secs)
    }

    fn ctx<'a>(root: &'a Path, worktree: &'a Path) -> HookContext<'a> {
        HookContext {
            project_slug: "acme",
            project_root: root,
            worktree_path: worktree,
            branch: "feature/x",
        }
    }

    #[test]
    fn resolve_hook_path_absolute_passthrough() {
        let root = Path::new("/some/root");
        let p = resolve_hook_path(root, "/abs/script.sh");
        assert_eq!(p, PathBuf::from("/abs/script.sh"));
    }

    #[test]
    fn resolve_hook_path_relative_joins_root() {
        let root = Path::new("/some/root");
        let p = resolve_hook_path(root, "scripts/setup.sh");
        assert_eq!(p, PathBuf::from("/some/root/scripts/setup.sh"));
    }

    #[test]
    fn happy_path_runs_script_in_cwd() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("proj");
        let wt = tmp.path().join("wt");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&wt).unwrap();

        let script = write_script(
            &root,
            "post.sh",
            "#!/bin/sh\ntouch \"$RAUM_WORKTREE_PATH/marker\"\necho ok\n",
        );

        let report = run_hook_retry(HookPhase::PostCreate, &script, &ctx(&root, &wt), 30).unwrap();
        assert!(wt.join("marker").exists(), "post-create ran with wt cwd");
        assert!(report.stdout_tail.contains("ok"));
    }

    #[test]
    fn non_zero_exit_returns_failed_with_stderr_tail() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let script = write_script(&root, "fail.sh", "#!/bin/sh\necho boom 1>&2\nexit 7\n");
        let err =
            run_hook_retry(HookPhase::PreCreate, &script, &ctx(&root, &root), 30).unwrap_err();
        match err {
            HookError::Failed {
                code, stderr_tail, ..
            } => {
                assert_eq!(code, Some(7));
                assert!(stderr_tail.contains("boom"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn timeout_kills_long_running_child() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let script = write_script(&root, "sleep.sh", "#!/bin/sh\nsleep 10\n");
        let err = run_hook_retry(HookPhase::PreCreate, &script, &ctx(&root, &root), 1).unwrap_err();
        assert!(matches!(err, HookError::Timeout { .. }), "got {err:?}");
    }

    #[test]
    fn env_vars_exposed_to_script() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let out = root.join("env.txt");
        let script = write_script(
            &root,
            "env.sh",
            &format!(
                "#!/bin/sh\n{{\n  echo \"phase=$RAUM_PHASE\"\n  echo \"slug=$RAUM_PROJECT_SLUG\"\n  echo \"root=$RAUM_PROJECT_ROOT\"\n  echo \"wt=$RAUM_WORKTREE_PATH\"\n  echo \"branch=$RAUM_BRANCH\"\n}} > \"{}\"\n",
                out.display()
            ),
        );
        run_hook_retry(HookPhase::PreCreate, &script, &ctx(&root, &root), 30).unwrap();
        let contents = fs::read_to_string(&out).unwrap();
        assert!(contents.contains("phase=pre-create"));
        assert!(contents.contains("slug=acme"));
        assert!(contents.contains(&format!("root={}", root.display())));
        assert!(contents.contains("branch=feature/x"));
    }

    #[test]
    fn missing_script_returns_not_found() {
        let tmp = tempdir().unwrap();
        let err = run_hook(
            HookPhase::PreCreate,
            &tmp.path().join("nope.sh"),
            &ctx(tmp.path(), tmp.path()),
            30,
        )
        .unwrap_err();
        assert!(matches!(err, HookError::NotFound { .. }));
    }
}
