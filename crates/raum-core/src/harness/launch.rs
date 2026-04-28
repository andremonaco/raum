//! Harness launch-command construction.
//!
//! Pure helpers shared by `terminal_spawn` (fresh sessions) and the
//! cold-start dead-pane revival path. Both call sites need to render
//! the same `<harness> [<flags>]` string into `tmux respawn-pane`, so
//! the logic lives here instead of inline in the Tauri layer.

use crate::agent::AgentKind;

/// Render the shell command that boots a harness inside a tmux pane.
///
/// `extra_flags` is the user-configured per-harness flag string (from
/// `config.harnesses.<kind>.extra_flags`). Empty / whitespace-only
/// values should be passed as `None` by the caller.
///
/// `opencode_port` is the TCP port to pin OpenCode to. The caller is
/// responsible for picking the port (parse from `extra_flags` if the
/// user supplied `--port`, reuse a persisted port on revival, or
/// reserve a fresh ephemeral port for first launch). Other harnesses
/// ignore it.
///
/// Returns `None` for `AgentKind::Shell` — there is no harness command
/// for a plain shell session; the caller falls back to the user's
/// login shell via tmux's default behavior.
#[must_use]
pub fn harness_launch_command(
    kind: AgentKind,
    extra_flags: Option<&str>,
    opencode_port: Option<u16>,
) -> Option<String> {
    let flags = extra_flags.map(str::trim).filter(|s| !s.is_empty());
    match kind {
        AgentKind::ClaudeCode => Some(match flags {
            Some(f) => format!("claude {f}"),
            None => "claude".to_string(),
        }),
        AgentKind::Codex => Some(match flags {
            Some(f) => format!("codex {f}"),
            None => "codex".to_string(),
        }),
        AgentKind::OpenCode => {
            let explicit_port = flags.and_then(parse_opencode_port_arg);
            // The caller already decided which port to use; we just
            // emit the command. If the user pinned `--port` in their
            // own flags, don't double-inject ours.
            Some(match (flags, explicit_port, opencode_port) {
                (Some(f), Some(_), _) => format!("opencode {f}"),
                (Some(f), None, Some(port)) => format!("opencode --port {port} {f}"),
                (Some(f), None, None) => format!("opencode {f}"),
                (None, _, Some(port)) => format!("opencode --port {port}"),
                (None, _, None) => "opencode".to_string(),
            })
        }
        AgentKind::Shell => None,
    }
}

/// Extract `--port <n>` / `--port=<n>` from a whitespace-separated
/// flags string. Used by callers that need to know whether the user
/// already pinned a port before reserving a fresh one.
#[must_use]
pub fn parse_opencode_port_arg(flags: &str) -> Option<u16> {
    let mut parts = flags.split_whitespace();
    while let Some(part) = parts.next() {
        if let Some(raw) = part.strip_prefix("--port=")
            && let Ok(port) = raw.parse::<u16>()
        {
            return Some(port);
        }
        if part == "--port"
            && let Some(raw) = parts.next()
            && let Ok(port) = raw.parse::<u16>()
        {
            return Some(port);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_returns_none() {
        assert_eq!(harness_launch_command(AgentKind::Shell, None, None), None);
        assert_eq!(
            harness_launch_command(AgentKind::Shell, Some("--anything"), Some(1234)),
            None,
        );
    }

    #[test]
    fn claude_without_flags() {
        assert_eq!(
            harness_launch_command(AgentKind::ClaudeCode, None, None).as_deref(),
            Some("claude"),
        );
    }

    #[test]
    fn claude_with_flags() {
        assert_eq!(
            harness_launch_command(AgentKind::ClaudeCode, Some("--verbose"), None).as_deref(),
            Some("claude --verbose"),
        );
    }

    #[test]
    fn empty_flags_treated_as_none() {
        assert_eq!(
            harness_launch_command(AgentKind::ClaudeCode, Some("   "), None).as_deref(),
            Some("claude"),
        );
    }

    #[test]
    fn codex_with_flags() {
        assert_eq!(
            harness_launch_command(AgentKind::Codex, Some("--model gpt-5"), None).as_deref(),
            Some("codex --model gpt-5"),
        );
    }

    #[test]
    fn opencode_no_port_no_flags() {
        assert_eq!(
            harness_launch_command(AgentKind::OpenCode, None, None).as_deref(),
            Some("opencode"),
        );
    }

    #[test]
    fn opencode_caller_supplied_port() {
        assert_eq!(
            harness_launch_command(AgentKind::OpenCode, None, Some(45123)).as_deref(),
            Some("opencode --port 45123"),
        );
    }

    #[test]
    fn opencode_user_pinned_port_wins() {
        // User pinned `--port 9000` in extra_flags; we honour it and
        // skip injecting our own.
        assert_eq!(
            harness_launch_command(AgentKind::OpenCode, Some("--port 9000"), Some(45123))
                .as_deref(),
            Some("opencode --port 9000"),
        );
    }

    #[test]
    fn opencode_flags_without_port_get_our_port() {
        assert_eq!(
            harness_launch_command(AgentKind::OpenCode, Some("--verbose"), Some(45123)).as_deref(),
            Some("opencode --port 45123 --verbose"),
        );
    }

    #[test]
    fn parse_port_short_form() {
        assert_eq!(parse_opencode_port_arg("--port 4242"), Some(4242));
        assert_eq!(parse_opencode_port_arg("--port=4242"), Some(4242));
        assert_eq!(parse_opencode_port_arg("--verbose --port 4242"), Some(4242));
        assert_eq!(parse_opencode_port_arg("--port"), None);
        assert_eq!(parse_opencode_port_arg("--port=abc"), None);
        assert_eq!(parse_opencode_port_arg(""), None);
    }
}
