//! Boot-time tmux version health check.
//!
//! tmux 3.4 ≤ v < 3.7b has a synchronized-output bug (tmux/tmux#5340): a
//! DECSET 2026 sync block containing a full-screen erase never flushes to the
//! client, so fullscreen TUIs garble and only repaint on a forced redraw.
//! Claude Code ≥ 2.1.200 wraps its initial paint in exactly such a block when
//! it detects tmux 3.4+, which is what makes the bug user-visible inside raum
//! panes (anthropics/claude-code#74122).
//!
//! Package managers don't close this gap for us: the Homebrew cask's
//! `depends_on formula: "tmux"` and the deb's `Depends: tmux` only guarantee
//! *presence* at install time — `brew upgrade --cask raum` never bumps an
//! already-installed tmux, and even after the binary is upgraded the running
//! `-L raum` server keeps executing the old version until it is reborn.
//!
//! So raum checks at boot and, when the *server* is in the buggy range, shows
//! a notice (`frontend/src/lib/tmuxVersionNotice.ts`). Two variants:
//!
//! - binary already fixed → offer the same deferred restart the TCC migration
//!   uses (`server_restart::server_restart_now`): flag, relaunch, cold-server
//!   rebirth picks up the new binary from PATH, rehydrate recovers sessions.
//! - binary also buggy → instruct the user to upgrade the package first; a
//!   restart now would just rebirth the same buggy version.
//!
//! Dismissal is keyed by the server version string, so declining "3.6a" stays
//! quiet for 3.6a but a future differently-buggy version re-notifies.

use serde::Serialize;

use crate::state::AppHandleState;

/// Whether the "tmux has a known display bug" notice should be shown.
#[derive(Debug, Clone, Serialize)]
pub struct TmuxVersionStatus {
    /// True when the running server's version is in a known-buggy range and
    /// the user hasn't dismissed the notice for that exact version.
    pub needed: bool,
    /// The running server's version string (empty when `needed` is false).
    pub server_version: String,
    /// True when the tmux binary on PATH is already outside the buggy range,
    /// so a server restart alone resolves it. False → upgrade the package
    /// first.
    pub binary_fixed: bool,
    /// How many sessions a restart would take down, for an honest prompt.
    pub live_sessions: u32,
}

const NOT_NEEDED: TmuxVersionStatus = TmuxVersionStatus {
    needed: false,
    server_version: String::new(),
    binary_fixed: false,
    live_sessions: 0,
};

/// Report whether the running `-L raum` server is on a known-buggy tmux.
#[tauri::command]
pub fn tmux_version_status(state: tauri::State<'_, AppHandleState>) -> TmuxVersionStatus {
    let Some(server_version) = state.tmux.server_version() else {
        return NOT_NEEDED;
    };
    if !has_sync_output_bug(&server_version) {
        return NOT_NEEDED;
    }
    let dismissed_for = super::server_restart::read_config(&state)
        .and_then(|c| c.terminals.tmux_version_hint_dismissed_for);
    if dismissed_for.as_deref() == Some(server_version.as_str()) {
        return NOT_NEEDED;
    }
    let binary_fixed = state
        .tmux
        .client_version()
        .is_some_and(|v| !has_sync_output_bug(&v));
    let live_sessions = state
        .tmux
        .list_sessions()
        .map_or(0, |s| u32::try_from(s.len()).unwrap_or(u32::MAX));
    tracing::info!(
        server_version,
        binary_fixed,
        live_sessions,
        "tmux-health: server in known-buggy version range; prompting",
    );
    TmuxVersionStatus {
        needed: true,
        server_version,
        binary_fixed,
        live_sessions,
    }
}

/// Record that the user never wants to hear about this server version again.
#[tauri::command]
pub fn tmux_version_dismiss(
    state: tauri::State<'_, AppHandleState>,
    version: String,
) -> Result<(), String> {
    super::server_restart::mutate_terminals(&state, |t| {
        t.tmux_version_hint_dismissed_for = Some(version);
    })
}

/// Parse a tmux version string: `"3.6a"` → `(3, 6, 1)`. Letter suffix maps
/// a=1, b=2, …; absent = 0, so `3.7 < 3.7a < 3.7b` orders correctly. Answers
/// `None` for anything else (`next-3.8`, `master`, garbage) — an unknown
/// version must never drive a prompt to destroy sessions.
fn parse_tmux_version(v: &str) -> Option<(u32, u32, u32)> {
    let (major, rest) = v.split_once('.')?;
    let major: u32 = major.parse().ok()?;
    let digits_end = rest
        .bytes()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(rest.len());
    let minor: u32 = rest[..digits_end].parse().ok()?;
    let letter = rest
        .as_bytes()
        .get(digits_end)
        .filter(|b| b.is_ascii_lowercase())
        .map_or(0, |&b| u32::from(b - b'a' + 1));
    Some((major, minor, letter))
}

/// tmux/tmux#5340 — present in 3.4 ≤ v < 3.7b (fixed by `e802909d`, first
/// shipped in 3.7b). Pre-3.4 is fine because Claude Code only enables sync
/// output on tmux 3.4+.
fn has_sync_output_bug(version: &str) -> bool {
    parse_tmux_version(version).is_some_and(|v| ((3, 4, 0)..(3, 7, 2)).contains(&v))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parsing_and_bug_range() {
        assert_eq!(parse_tmux_version("3.6a"), Some((3, 6, 1)));
        assert_eq!(parse_tmux_version("3.7b"), Some((3, 7, 2)));
        assert_eq!(parse_tmux_version("3.5"), Some((3, 5, 0)));
        assert_eq!(parse_tmux_version("next-3.8"), None);
        assert_eq!(parse_tmux_version("master"), None);
        assert_eq!(parse_tmux_version(""), None);

        assert!(has_sync_output_bug("3.4"));
        assert!(has_sync_output_bug("3.5a"));
        assert!(has_sync_output_bug("3.6a"));
        assert!(has_sync_output_bug("3.7"));
        assert!(has_sync_output_bug("3.7a"));
        assert!(!has_sync_output_bug("3.7b"));
        assert!(!has_sync_output_bug("3.8"));
        assert!(
            !has_sync_output_bug("3.3a"),
            "pre-3.4: CC never enables sync"
        );
        assert!(
            !has_sync_output_bug("next-3.8"),
            "unparsable must not prompt"
        );
    }
}
