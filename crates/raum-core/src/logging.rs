//! Tracing setup (§2.8).
//!
//! - Daily-rotating log files at `<logs_dir>/raum.log` (tracing-appender appends
//!   `.YYYY-MM-DD` to the stem, so entries land in `raum.log.YYYY-MM-DD`).
//! - 3-day retention — anything older is pruned at startup.
//! - Default level INFO; `RUST_LOG` overrides.
//! - stderr mirror when the process is attached to a TTY.

use std::io::IsTerminal;
use std::path::Path;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::filter::EnvFilter;
use tracing_subscriber::fmt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// Number of rotating log files to retain. 3 days matches the spec.
pub const LOG_RETENTION_DAYS: usize = 3;

/// File stem used by the rolling appender. Actual files are `raum.log.YYYY-MM-DD`.
pub const LOG_FILE_STEM: &str = "raum.log";

/// Initialize tracing with daily-rotating files in `logs_dir` and an optional
/// stderr mirror. Returns the worker guard; drop it on shutdown to flush.
pub fn init_tracing(logs_dir: &Path) -> WorkerGuard {
    std::fs::create_dir_all(logs_dir).ok();
    prune_old_logs(logs_dir, LOG_RETENTION_DAYS);

    let file_appender = tracing_appender::rolling::daily(logs_dir, LOG_FILE_STEM);
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let file_layer = fmt::layer()
        .with_writer(file_writer)
        .with_target(true)
        .with_ansi(false);

    let stderr_layer = if std::io::stderr().is_terminal() {
        Some(
            fmt::layer()
                .with_writer(std::io::stderr)
                .with_target(true)
                .with_ansi(true),
        )
    } else {
        None
    };

    tracing_subscriber::registry()
        .with(env_filter)
        .with(file_layer)
        .with(stderr_layer)
        .init();

    guard
}

/// Keep only the `keep` newest files whose name starts with `raum.log.`.
///
/// Public so tests (and ops tooling) can invoke it deterministically.
pub fn prune_old_logs(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter(|e| {
            let name = e.file_name();
            let n = name.to_string_lossy();
            n.starts_with("raum.log.") || n == "raum.log"
        })
        .collect();
    // File names embed `YYYY-MM-DD`, so lexicographic sort is chronological.
    files.sort_by_key(|e| e.file_name());
    if files.len() > keep {
        let drop_count = files.len() - keep;
        for f in files.into_iter().take(drop_count) {
            if let Err(e) = std::fs::remove_file(f.path()) {
                tracing::warn!(path = %f.path().display(), error = %e, "prune failed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn prune_keeps_newest_three_of_five() {
        let dir = tempdir().unwrap();
        let names = [
            "raum.log.2026-04-09",
            "raum.log.2026-04-10",
            "raum.log.2026-04-11",
            "raum.log.2026-04-12",
            "raum.log.2026-04-13",
        ];
        for n in &names {
            std::fs::write(dir.path().join(n), b"test").unwrap();
        }
        prune_old_logs(dir.path(), 3);

        let mut remaining: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        remaining.sort();
        assert_eq!(
            remaining,
            vec![
                "raum.log.2026-04-11".to_string(),
                "raum.log.2026-04-12".to_string(),
                "raum.log.2026-04-13".to_string(),
            ]
        );
    }

    #[test]
    fn prune_ignores_unrelated_files() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("README"), b"hi").unwrap();
        std::fs::write(dir.path().join("raum.log.2026-04-13"), b"hi").unwrap();
        prune_old_logs(dir.path(), 3);
        assert!(dir.path().join("README").exists());
        assert!(dir.path().join("raum.log.2026-04-13").exists());
    }

    #[test]
    fn prune_handles_missing_dir_gracefully() {
        prune_old_logs(Path::new("/nonexistent/raum/logs"), 3);
    }

    #[test]
    fn prune_noop_when_below_threshold() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("raum.log.2026-04-12"), b"x").unwrap();
        std::fs::write(dir.path().join("raum.log.2026-04-13"), b"x").unwrap();
        prune_old_logs(dir.path(), 3);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }
}
