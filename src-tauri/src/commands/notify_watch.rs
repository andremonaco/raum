//! Shared self-heal scaffolding for `notify`-based watchers.
//!
//! Both [`git_watcher`](super::git_watcher) and
//! [`worktree::fs_watcher`](super::worktree) wrap a `notify` backend that can
//! die under fd/watch pressure — `EMFILE` on macOS FSEvents, `ENOSPC` on Linux
//! inotify — and only recover with a fresh watcher. The bookkeeping for that is
//! identical and easy to get subtly wrong, so it lives here once:
//!
//! * [`HealthState`] — the error/rebuild state machine (record ok/err,
//!   rebuild-eligibility, exponential backoff after failed rebuilds).
//! * [`ErrorRateMap`] + [`emit_rate_limited_error`] — one WARN per
//!   `(kind, error)` per [`ERROR_WARN_WINDOW`], with a suppression count, so a
//!   sustained-error storm stays a handful of log lines.
//!
//! What is NOT shared lives in each watcher: the notify callback, the watch
//! registration, the debounce loop (different payloads/actions), and the ~15
//! lines of supervisor glue that build + swap that watcher's own `Inner`. Those
//! differ enough that a shared abstraction would be worse than the duplication.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tracing::{info, warn};

/// One WARN per `(kind, error)` per this window, then a single suppression-count
/// INFO at window close — a 7 000-warn/day burst becomes ~30 lines while the
/// transitions stay visible.
const ERROR_WARN_WINDOW: Duration = Duration::from_secs(60);

/// Sustained-error duration that justifies a rebuild. Below this, an occasional
/// `EMFILE`/`ENOSPC` during a transient spike is left alone — the stream usually
/// recovers on its own. Above it the stream is effectively dead.
const REBUILD_AFTER_SUSTAINED_ERRORS: Duration = Duration::from_secs(30);

/// Consecutive errors required (on top of the time threshold) before rebuilding.
/// Guards against rebuilding on a single transient error near a tick boundary.
const REBUILD_MIN_ERR_COUNT: u64 = 3;

/// Initial wait between rebuild attempts after a failure; doubles up to the
/// ceiling.
const REBUILD_BACKOFF_INITIAL: Duration = Duration::from_secs(30);
const REBUILD_BACKOFF_CEILING: Duration = Duration::from_secs(300);

/// How often a supervisor checks its watcher's health.
pub(crate) const SUPERVISOR_TICK: Duration = Duration::from_secs(15);

/// Per-error-string WARN rate limiter. One instance per watcher, so the watcher
/// `kind` is fixed and only the error string varies — hence keyed by error.
#[derive(Default)]
pub(crate) struct ErrorRateMap {
    by_error: HashMap<String, KindBucket>,
}

struct KindBucket {
    window_start: Instant,
    suppressed: u64,
}

/// Emit at most one WARN per `(kind, error)` per [`ERROR_WARN_WINDOW`], then a
/// single suppression-count INFO at the window's end. `kind` is the watcher type
/// (e.g. `"git_watcher"`) and forms the log message prefix — kept byte-identical
/// so existing log greps keep matching; `id` is the instance identifier (project
/// slug, worktree path) carried as a structured field. Runs on notify's backend
/// thread, so a poisoned mutex drops the log rather than panicking.
pub(crate) fn emit_rate_limited_error(
    state: &Arc<Mutex<ErrorRateMap>>,
    kind: &str,
    id: impl std::fmt::Display,
    err: &notify::Error,
) {
    let key = format!("{err}");
    let Ok(mut state) = state.lock() else {
        return;
    };
    let now = Instant::now();
    match state.by_error.get_mut(&key) {
        None => {
            state.by_error.insert(
                key.clone(),
                KindBucket {
                    window_start: now,
                    suppressed: 0,
                },
            );
            warn!(id = %id, error = %key, "{kind}: notify error");
        }
        Some(bucket) => {
            if now.duration_since(bucket.window_start) >= ERROR_WARN_WINDOW {
                if bucket.suppressed > 0 {
                    info!(
                        id = %id,
                        error = %key,
                        suppressed = bucket.suppressed,
                        window_secs = ERROR_WARN_WINDOW.as_secs(),
                        "{kind}: suppressed repeated notify errors",
                    );
                }
                bucket.window_start = now;
                bucket.suppressed = 0;
                warn!(id = %id, error = %key, "{kind}: notify error");
            } else {
                bucket.suppressed = bucket.suppressed.saturating_add(1);
            }
        }
    }
}

/// Error/rebuild health for one watcher. The notify callback feeds it
/// [`record_ok`](Self::record_ok)/[`record_err`](Self::record_err); the
/// supervisor drives rebuilds via [`rebuild_due`](Self::rebuild_due) /
/// [`mark_rebuilt`](Self::mark_rebuilt) / [`defer_rebuild`](Self::defer_rebuild).
#[derive(Default)]
pub(crate) struct HealthState {
    /// First error since the last successful event reception, if any.
    first_err_at: Option<Instant>,
    /// Errors observed since the last successful event.
    err_count: u64,
    /// Consecutive rebuild failures, for exponential backoff.
    rebuild_attempts: u32,
    /// Earliest time a previously-failed rebuild may be retried. `None` = no
    /// pending backoff.
    next_rebuild_eligible_at: Option<Instant>,
}

impl HealthState {
    /// A successful event arrived — the stream is alive; clear the error run.
    pub(crate) fn record_ok(&mut self) {
        self.first_err_at = None;
        self.err_count = 0;
    }

    /// A notify backend error arrived; start/extend the current error run.
    pub(crate) fn record_err(&mut self, now: Instant) {
        self.err_count = self.err_count.saturating_add(1);
        if self.first_err_at.is_none() {
            self.first_err_at = Some(now);
        }
    }

    /// `Some(err_count)` when notify has been erroring for
    /// [`REBUILD_AFTER_SUSTAINED_ERRORS`] with at least [`REBUILD_MIN_ERR_COUNT`]
    /// errors and any post-failure backoff has elapsed — i.e. it's time to
    /// rebuild. The count is returned for logging.
    pub(crate) fn rebuild_due(&self, now: Instant) -> Option<u64> {
        if let Some(eligible) = self.next_rebuild_eligible_at {
            if now < eligible {
                return None;
            }
        }
        match self.first_err_at {
            Some(first)
                if now.duration_since(first) >= REBUILD_AFTER_SUSTAINED_ERRORS
                    && self.err_count >= REBUILD_MIN_ERR_COUNT =>
            {
                Some(self.err_count)
            }
            _ => None,
        }
    }

    /// Reset after a successful rebuild.
    pub(crate) fn mark_rebuilt(&mut self) {
        self.first_err_at = None;
        self.err_count = 0;
        self.rebuild_attempts = 0;
        self.next_rebuild_eligible_at = None;
    }

    /// Record a failed rebuild and schedule the next eligible retry. Returns the
    /// `(attempt, backoff)` applied, for logging.
    pub(crate) fn defer_rebuild(&mut self, now: Instant) -> (u32, Duration) {
        self.rebuild_attempts = self.rebuild_attempts.saturating_add(1);
        let backoff = backoff_for_attempt(self.rebuild_attempts);
        self.next_rebuild_eligible_at = Some(now + backoff);
        (self.rebuild_attempts, backoff)
    }
}

/// Exponential backoff schedule: 30 s, 60 s, 120 s, 240 s, capped at the 300 s
/// ceiling. `attempt` is 1-indexed.
fn backoff_for_attempt(attempt: u32) -> Duration {
    let shift = attempt.saturating_sub(1).min(8);
    let mult = 1u64 << shift;
    let secs = REBUILD_BACKOFF_INITIAL
        .as_secs()
        .saturating_mul(mult)
        .min(REBUILD_BACKOFF_CEILING.as_secs());
    Duration::from_secs(secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_ok_clears_an_error_run() {
        let mut h = HealthState::default();
        let t0 = Instant::now();
        h.record_err(t0);
        h.record_err(t0);
        assert!(h.first_err_at.is_some());
        assert_eq!(h.err_count, 2);
        h.record_ok();
        assert!(h.first_err_at.is_none());
        assert_eq!(h.err_count, 0);
    }

    #[test]
    fn rebuild_due_needs_both_time_and_count() {
        let mut h = HealthState::default();
        let t0 = Instant::now();
        // One error, just now: neither threshold met.
        h.record_err(t0);
        assert_eq!(h.rebuild_due(t0), None);
        // Enough errors but not enough elapsed time.
        h.record_err(t0);
        h.record_err(t0);
        assert_eq!(h.rebuild_due(t0), None);
        // Enough time AND count → due, reporting the count.
        let later = t0 + REBUILD_AFTER_SUSTAINED_ERRORS + Duration::from_secs(1);
        assert_eq!(h.rebuild_due(later), Some(3));
    }

    #[test]
    fn rebuild_due_respects_backoff_then_clears_on_rebuilt() {
        let mut h = HealthState::default();
        let t0 = Instant::now();
        for _ in 0..REBUILD_MIN_ERR_COUNT {
            h.record_err(t0);
        }
        let due_at = t0 + REBUILD_AFTER_SUSTAINED_ERRORS + Duration::from_secs(1);
        assert!(h.rebuild_due(due_at).is_some());

        // A failed rebuild defers the next attempt by the backoff.
        let (attempt, backoff) = h.defer_rebuild(due_at);
        assert_eq!(attempt, 1);
        assert_eq!(backoff, Duration::from_secs(30));
        assert_eq!(h.rebuild_due(due_at), None); // still backing off
        assert!(h.rebuild_due(due_at + backoff).is_some()); // backoff elapsed

        // A successful rebuild fully resets.
        h.mark_rebuilt();
        assert_eq!(h.rebuild_due(due_at + backoff), None);
        assert_eq!(h.rebuild_attempts, 0);
    }

    #[test]
    fn backoff_grows_then_caps() {
        assert_eq!(backoff_for_attempt(1), Duration::from_secs(30));
        assert_eq!(backoff_for_attempt(2), Duration::from_secs(60));
        assert_eq!(backoff_for_attempt(3), Duration::from_secs(120));
        assert_eq!(backoff_for_attempt(4), Duration::from_secs(240));
        assert_eq!(backoff_for_attempt(5), Duration::from_secs(300));
        assert_eq!(backoff_for_attempt(99), Duration::from_secs(300));
    }
}
