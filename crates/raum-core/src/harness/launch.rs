//! Harness launch-command construction.
//!
//! Pure helpers shared by `terminal_spawn` (fresh sessions) and the
//! cold-start dead-pane revival path. Both call sites need to render
//! the same `<harness> [<flags>]` string into `tmux respawn-pane`, so
//! the logic lives here instead of inline in the Tauri layer.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

use crate::agent::AgentKind;

/// Per-spawn model selection layered on top of the user's global
/// `extra_flags` config. Used by the cross-harness review picker to ship a
/// one-shot `--model`/`--effort` choice down to `terminal_spawn` without
/// mutating `config.toml`.
///
/// `effort` is harness-specific:
///
/// * Claude Code: `--effort low|medium|high|xhigh|max` (session-scoped).
/// * Codex: applied as `-c model_reasoning_effort=<e>` because Codex reads
///   reasoning effort from `config.toml`/`-c` overrides, not a top-level flag.
/// * OpenCode: ignored in v1 — OpenCode reads thinking budgets from
///   `~/.config/opencode/opencode.json` per `provider/model` and a
///   per-spawn override would require mutating that JSON. Out of scope here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelOverride {
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

impl ModelOverride {
    fn trimmed_model(&self) -> Option<&str> {
        let m = self.model.trim();
        if m.is_empty() { None } else { Some(m) }
    }

    fn trimmed_effort(&self) -> Option<&str> {
        self.effort
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }
}

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
    harness_launch_command_with_prompt(kind, extra_flags, opencode_port, None)
}

/// Like [`harness_launch_command`] but appends a shell-escaped initial
/// `prompt` to the command. The prompt becomes the harness's first turn
/// when it boots — every harness CLI we support accepts a positional
/// prompt argument. Used by the cross-harness review feature to seed a
/// reviewer with a brief.
///
/// `prompt = None` (or `Some("")`) is equivalent to
/// [`harness_launch_command`] — no prompt is appended.
///
/// Shell-Shell escaping uses POSIX single-quote wrapping: every `'` in the
/// prompt is replaced with `'\''` and the whole thing is wrapped in
/// `'...'`. Tmux invokes the rendered command via `sh -c`, so this is the
/// safe canonical form for arbitrary text including newlines, backticks,
/// and `$`.
///
/// **Note on argument size:** `ARG_MAX` is at least 256 KB on macOS and
/// usually >2 MB on Linux. Our briefs are typically a few KB — well under
/// the limit. Callers who want extra safety can write the brief to a file
/// and seed a "Read <path> and follow its instructions." prompt instead.
///
/// **OpenCode delivers its prompt out-of-band.** OpenCode's bare
/// `opencode` command does not accept a positional initial prompt — and
/// the `opencode run '<prompt>'` subcommand is one-shot non-interactive
/// (prints output, exits), which is the wrong shape for a reviewer pane
/// the user wants to keep iterating with. So for OpenCode we ignore
/// `prompt` here and always emit interactive `opencode --port <p> [...]`.
/// The brief is injected after the TUI is up via OpenCode's documented
/// `/tui/append-prompt` + `/tui/submit-prompt` HTTP endpoints (the same
/// path OpenCode's IDE plugins use). Call site: `terminal_spawn`.
#[must_use]
pub fn harness_launch_command_with_prompt(
    kind: AgentKind,
    extra_flags: Option<&str>,
    opencode_port: Option<u16>,
    prompt: Option<&str>,
) -> Option<String> {
    harness_launch_command_with_prompt_and_override(kind, extra_flags, opencode_port, prompt, None)
}

/// Like [`harness_launch_command_with_prompt`] but layers a one-shot
/// [`ModelOverride`] (model id + optional effort) on top of `extra_flags`.
/// Used by the cross-harness review picker.
///
/// Precedence: a user-pinned conflicting flag in `extra_flags` always wins.
/// We only inject `--model`/`--effort` when the corresponding flag is
/// **not** already present in `extra_flags`, so a global override the user
/// committed to `config.toml` is never silently overridden.
#[must_use]
pub fn harness_launch_command_with_prompt_and_override(
    kind: AgentKind,
    extra_flags: Option<&str>,
    opencode_port: Option<u16>,
    prompt: Option<&str>,
    override_: Option<&ModelOverride>,
) -> Option<String> {
    let flags = extra_flags.map(str::trim).filter(|s| !s.is_empty());
    let prompt_arg = prompt
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|p| format!(" {}", shell_single_quote(p)));
    let prompt_suffix = prompt_arg.as_deref().unwrap_or("");

    match kind {
        AgentKind::ClaudeCode => Some(render_claude(flags, prompt_suffix, override_)),
        AgentKind::Codex => Some(render_codex(flags, prompt_suffix, override_)),
        AgentKind::OpenCode => {
            // OpenCode is always launched as the interactive TUI. Any
            // `prompt` is intentionally ignored here — see the doc-comment
            // above. The caller (terminal_spawn) is responsible for
            // delivering the prompt over OpenCode's HTTP API once the TUI
            // is up. If the user pinned `--port` in their own flags,
            // honour it; otherwise inject the port we picked.
            let _ = prompt_suffix; // intentionally unused for OpenCode
            Some(render_opencode(flags, opencode_port, override_))
        }
        AgentKind::Shell => None,
    }
}

fn render_claude(flags: Option<&str>, prompt_suffix: &str, ovr: Option<&ModelOverride>) -> String {
    let mut prefix = String::new();
    if let Some(o) = ovr {
        if let Some(model) = o.trimmed_model()
            && !flags_contain_token(flags, "--model")
        {
            let _ = write!(prefix, "--model {} ", shell_single_quote(model));
        }
        if let Some(effort) = o.trimmed_effort()
            && !flags_contain_token(flags, "--effort")
        {
            let _ = write!(prefix, "--effort {} ", shell_single_quote(effort));
        }
    }
    let trimmed_prefix = prefix.trim_end();
    match (flags, trimmed_prefix.is_empty()) {
        (Some(f), true) => format!("claude {f}{prompt_suffix}"),
        (Some(f), false) => format!("claude {trimmed_prefix} {f}{prompt_suffix}"),
        (None, true) => format!("claude{prompt_suffix}"),
        (None, false) => format!("claude {trimmed_prefix}{prompt_suffix}"),
    }
}

fn render_codex(flags: Option<&str>, prompt_suffix: &str, ovr: Option<&ModelOverride>) -> String {
    let mut prefix = String::new();
    let mut suffix = String::new();
    if let Some(o) = ovr {
        if let Some(model) = o.trimmed_model()
            && !flags_contain_any(flags, &["--model", "-m"])
        {
            let _ = write!(prefix, "-m {} ", shell_single_quote(model));
        }
        if let Some(effort) = o.trimmed_effort()
            && !flags_contain_effort_override(flags)
        {
            // Codex consumes reasoning effort via `-c model_reasoning_effort=<e>`.
            // Effort values are unquoted-ASCII (low/medium/high/xhigh) so we can
            // emit them inline without shell quoting.
            let _ = write!(suffix, " -c model_reasoning_effort={effort}");
        }
    }
    let trimmed_prefix = prefix.trim_end();
    let base = match (flags, trimmed_prefix.is_empty()) {
        (Some(f), true) => format!("codex {f}"),
        (Some(f), false) => format!("codex {trimmed_prefix} {f}"),
        (None, true) => "codex".to_string(),
        (None, false) => format!("codex {trimmed_prefix}"),
    };
    format!("{base}{suffix}{prompt_suffix}")
}

fn render_opencode(
    flags: Option<&str>,
    opencode_port: Option<u16>,
    ovr: Option<&ModelOverride>,
) -> String {
    let explicit_port = flags.and_then(parse_opencode_port_arg);
    let mut model_prefix = String::new();
    if let Some(o) = ovr
        && let Some(model) = o.trimmed_model()
        && !flags_contain_token(flags, "--model")
        && !flags_contain_token(flags, "-m")
    {
        let _ = write!(model_prefix, "--model {} ", shell_single_quote(model));
    }
    let model_prefix = model_prefix.trim_end();
    match (flags, explicit_port, opencode_port, model_prefix.is_empty()) {
        (Some(f), Some(_), _, true) => format!("opencode {f}"),
        (Some(f), Some(_), _, false) => format!("opencode {model_prefix} {f}"),
        (Some(f), None, Some(port), true) => format!("opencode --port {port} {f}"),
        (Some(f), None, Some(port), false) => {
            format!("opencode --port {port} {model_prefix} {f}")
        }
        (Some(f), None, None, true) => format!("opencode {f}"),
        (Some(f), None, None, false) => format!("opencode {model_prefix} {f}"),
        (None, _, Some(port), true) => format!("opencode --port {port}"),
        (None, _, Some(port), false) => format!("opencode --port {port} {model_prefix}"),
        (None, _, None, true) => "opencode".to_string(),
        (None, _, None, false) => format!("opencode {model_prefix}"),
    }
}

/// Whitespace-aware substring probe: does `flags` already contain `token` as
/// a standalone argument (possibly followed by `=value`)? Cheap and good
/// enough for the conflict check — we'd rather skip injection than override
/// a flag the user pinned globally.
fn flags_contain_token(flags: Option<&str>, token: &str) -> bool {
    let Some(f) = flags else {
        return false;
    };
    let eq = format!("{token}=");
    f.split_whitespace()
        .any(|part| part == token || part.starts_with(&eq))
}

fn flags_contain_any(flags: Option<&str>, tokens: &[&str]) -> bool {
    tokens.iter().any(|t| flags_contain_token(flags, t))
}

/// Codex puts effort overrides under `-c model_reasoning_effort=<value>`,
/// usually written as the next whitespace-separated token after `-c`.
fn flags_contain_effort_override(flags: Option<&str>) -> bool {
    let Some(f) = flags else {
        return false;
    };
    let mut parts = f.split_whitespace().peekable();
    while let Some(part) = parts.next() {
        if part == "-c"
            && let Some(next) = parts.peek()
            && next.starts_with("model_reasoning_effort=")
        {
            return true;
        }
        if let Some(rest) = part.strip_prefix("-c=")
            && rest.starts_with("model_reasoning_effort=")
        {
            return true;
        }
    }
    false
}

/// Render the shell command that resumes an existing harness session inside
/// a tmux pane. Used by the dead-pane recovery path so the harness — not
/// raum — owns the rehydration of conversation state.
///
/// The harness loads its own JSONL/SQLite state by id and renders a clean
/// frame from scratch, sidestepping every problem with replaying tmux
/// scrollback for in-place-redraw TUIs.
///
/// Per-harness syntax:
///
/// * Claude Code: `claude --resume <id> [extra_flags]`
/// * Codex: `codex resume [extra_flags] <id>` (subcommand, not a flag)
/// * OpenCode: `opencode --session <id> [--port <port>] [extra_flags]`
/// * Shell: `None` — shells have no session concept.
///
/// Returns `None` if the kind has no resume form (Shell) or
/// `harness_session_id` is empty after trimming.
///
/// **Critical safety property:** This must only be invoked when the prior
/// harness process is gone. Two processes resuming the same session id
/// race on the underlying state file (Claude's JSONL has documented
/// concurrent-write corruption; Codex's rollout is append-only; OpenCode's
/// SQLite serialises but is not designed for multi-writer agent flows).
/// The caller is responsible for verifying via `tmux check_pane_dead`.
#[must_use]
pub fn harness_resume_command(
    kind: AgentKind,
    extra_flags: Option<&str>,
    opencode_port: Option<u16>,
    harness_session_id: &str,
) -> Option<String> {
    let id = harness_session_id.trim();
    if id.is_empty() {
        return None;
    }
    let id_quoted = shell_single_quote(id);
    let flags = extra_flags.map(str::trim).filter(|s| !s.is_empty());

    match kind {
        AgentKind::ClaudeCode => Some(match flags {
            Some(f) => format!("claude --resume {id_quoted} {f}"),
            None => format!("claude --resume {id_quoted}"),
        }),
        AgentKind::Codex => Some(match flags {
            Some(f) => format!("codex resume {f} {id_quoted}"),
            None => format!("codex resume {id_quoted}"),
        }),
        AgentKind::OpenCode => {
            // Same port-handling rules as the launch path: caller-pinned
            // `--port` in extra_flags wins; otherwise inject the chosen
            // port. The session id goes through `--session <id>`.
            let explicit_port = flags.and_then(parse_opencode_port_arg);
            Some(match (flags, explicit_port, opencode_port) {
                (Some(f), Some(_), _) => format!("opencode --session {id_quoted} {f}"),
                (Some(f), None, Some(port)) => {
                    format!("opencode --session {id_quoted} --port {port} {f}")
                }
                (Some(f), None, None) => format!("opencode --session {id_quoted} {f}"),
                (None, _, Some(port)) => format!("opencode --session {id_quoted} --port {port}"),
                (None, _, None) => format!("opencode --session {id_quoted}"),
            })
        }
        AgentKind::Shell => None,
    }
}

/// POSIX-safe single-quote wrap. The output is always quoted (even for the
/// empty string) so it can be appended after a space without further
/// escaping at the caller.
fn shell_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            // Close the open '...', emit a literal escaped quote, reopen.
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
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
    fn codex_preserves_user_no_alt_screen_flag() {
        assert_eq!(
            harness_launch_command(
                AgentKind::Codex,
                Some("--no-alt-screen --model gpt-5"),
                None
            )
            .as_deref(),
            Some("codex --no-alt-screen --model gpt-5"),
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

    // ---- with_prompt variants ----------------------------------------

    #[test]
    fn claude_with_prompt_no_flags() {
        let cmd = harness_launch_command_with_prompt(
            AgentKind::ClaudeCode,
            None,
            None,
            Some("review the diff"),
        )
        .unwrap();
        assert_eq!(cmd, "claude 'review the diff'");
    }

    #[test]
    fn claude_with_prompt_and_flags() {
        let cmd = harness_launch_command_with_prompt(
            AgentKind::ClaudeCode,
            Some("--verbose"),
            None,
            Some("hi"),
        )
        .unwrap();
        assert_eq!(cmd, "claude --verbose 'hi'");
    }

    #[test]
    fn codex_with_prompt() {
        let cmd = harness_launch_command_with_prompt(AgentKind::Codex, None, None, Some("review"))
            .unwrap();
        assert_eq!(cmd, "codex 'review'");
    }

    #[test]
    fn opencode_with_prompt_stays_interactive() {
        // The prompt is delivered over OpenCode's HTTP API after launch
        // (see `review::inject_opencode_brief`), so the launch command
        // must remain interactive — no `run` subcommand, no `--prompt`
        // flag baked in. The pinned port is preserved.
        let cmd = harness_launch_command_with_prompt(
            AgentKind::OpenCode,
            None,
            Some(45123),
            Some("look at this"),
        )
        .unwrap();
        assert_eq!(cmd, "opencode --port 45123");
        assert!(!cmd.contains("run "));
        assert!(!cmd.contains("--prompt"));
    }

    #[test]
    fn opencode_with_prompt_preserves_user_flags() {
        let cmd = harness_launch_command_with_prompt(
            AgentKind::OpenCode,
            Some("--model claude-sonnet"),
            Some(45123),
            Some("review this"),
        )
        .unwrap();
        assert_eq!(cmd, "opencode --port 45123 --model claude-sonnet");
    }

    #[test]
    fn opencode_without_prompt_stays_interactive() {
        // No prompt → no `run` subcommand → interactive TUI as usual,
        // including the auto-injected port.
        let cmd = harness_launch_command_with_prompt(AgentKind::OpenCode, None, Some(45123), None)
            .unwrap();
        assert_eq!(cmd, "opencode --port 45123");
    }

    #[test]
    fn empty_prompt_is_treated_as_none() {
        let cmd = harness_launch_command_with_prompt(AgentKind::ClaudeCode, None, None, Some(""))
            .unwrap();
        assert_eq!(cmd, "claude");
        let cmd2 =
            harness_launch_command_with_prompt(AgentKind::ClaudeCode, None, None, Some("   "))
                .unwrap();
        assert_eq!(cmd2, "claude");
    }

    #[test]
    fn shell_command_returns_none_even_with_prompt() {
        assert!(
            harness_launch_command_with_prompt(AgentKind::Shell, None, None, Some("x")).is_none()
        );
    }

    #[test]
    fn prompt_with_single_quotes_is_safely_escaped() {
        // Single quotes are the dangerous character for `sh -c`-style
        // shell quoting. The canonical form is to close the quote, emit
        // an escaped quote, and reopen.
        let cmd = harness_launch_command_with_prompt(
            AgentKind::ClaudeCode,
            None,
            None,
            Some("don't break"),
        )
        .unwrap();
        assert_eq!(cmd, r"claude 'don'\''t break'");
    }

    #[test]
    fn prompt_with_newlines_and_metachars_is_quoted_verbatim() {
        // Newlines, backticks, $, ", \\ — none of these need extra
        // escaping inside a single-quoted POSIX string.
        let prompt = "line1\nline2 `backtick` $VAR \"quoted\" back\\slash";
        let cmd =
            harness_launch_command_with_prompt(AgentKind::Codex, None, None, Some(prompt)).unwrap();
        assert_eq!(
            cmd,
            "codex 'line1\nline2 `backtick` $VAR \"quoted\" back\\slash'"
        );
    }

    #[test]
    fn shell_single_quote_basic_cases() {
        assert_eq!(shell_single_quote(""), "''");
        assert_eq!(shell_single_quote("hello"), "'hello'");
        assert_eq!(shell_single_quote("a'b"), r"'a'\''b'");
        assert_eq!(shell_single_quote("'leading"), r"''\''leading'");
        assert_eq!(shell_single_quote("trailing'"), r"'trailing'\'''");
    }

    // ---- resume command builder -------------------------------------

    #[test]
    fn resume_shell_returns_none() {
        assert_eq!(
            harness_resume_command(AgentKind::Shell, None, None, "anything"),
            None,
        );
    }

    #[test]
    fn resume_empty_session_id_returns_none() {
        assert_eq!(
            harness_resume_command(AgentKind::ClaudeCode, None, None, ""),
            None,
        );
        assert_eq!(
            harness_resume_command(AgentKind::ClaudeCode, None, None, "   "),
            None,
        );
    }

    #[test]
    fn resume_claude_no_flags() {
        let cmd = harness_resume_command(AgentKind::ClaudeCode, None, None, "abc-uuid").unwrap();
        assert_eq!(cmd, "claude --resume 'abc-uuid'");
    }

    #[test]
    fn resume_claude_with_flags() {
        let cmd =
            harness_resume_command(AgentKind::ClaudeCode, Some("--verbose"), None, "abc-uuid")
                .unwrap();
        assert_eq!(cmd, "claude --resume 'abc-uuid' --verbose");
    }

    #[test]
    fn resume_codex_uses_subcommand_form() {
        // Codex's resume is a subcommand (`codex resume <id>`), not a flag.
        let cmd = harness_resume_command(AgentKind::Codex, None, None, "rollout-uuid").unwrap();
        assert_eq!(cmd, "codex resume 'rollout-uuid'");
    }

    #[test]
    fn resume_codex_with_flags() {
        let cmd = harness_resume_command(
            AgentKind::Codex,
            Some("--model gpt-5"),
            None,
            "rollout-uuid",
        )
        .unwrap();
        assert_eq!(cmd, "codex resume --model gpt-5 'rollout-uuid'");
    }

    #[test]
    fn resume_codex_preserves_user_no_alt_screen_flag() {
        let cmd = harness_resume_command(
            AgentKind::Codex,
            Some("--no-alt-screen --model gpt-5"),
            None,
            "rollout-uuid",
        )
        .unwrap();
        assert_eq!(
            cmd,
            "codex resume --no-alt-screen --model gpt-5 'rollout-uuid'"
        );
    }

    #[test]
    fn resume_opencode_no_port_no_flags() {
        let cmd = harness_resume_command(AgentKind::OpenCode, None, None, "ulid-x").unwrap();
        assert_eq!(cmd, "opencode --session 'ulid-x'");
    }

    #[test]
    fn resume_opencode_caller_supplied_port() {
        let cmd = harness_resume_command(AgentKind::OpenCode, None, Some(45123), "ulid-x").unwrap();
        assert_eq!(cmd, "opencode --session 'ulid-x' --port 45123");
    }

    #[test]
    fn resume_opencode_user_pinned_port_wins() {
        let cmd = harness_resume_command(
            AgentKind::OpenCode,
            Some("--port 9000"),
            Some(45123),
            "ulid-x",
        )
        .unwrap();
        assert_eq!(cmd, "opencode --session 'ulid-x' --port 9000");
    }

    #[test]
    fn resume_opencode_flags_without_port_get_our_port() {
        let cmd = harness_resume_command(
            AgentKind::OpenCode,
            Some("--verbose"),
            Some(45123),
            "ulid-x",
        )
        .unwrap();
        assert_eq!(cmd, "opencode --session 'ulid-x' --port 45123 --verbose");
    }

    #[test]
    fn resume_session_id_with_quote_is_safely_escaped() {
        // Defensive — the harnesses generate UUIDs/ULIDs without quotes,
        // but we shell-quote the id anyway to keep the contract uniform.
        let cmd = harness_resume_command(AgentKind::ClaudeCode, None, None, "weird'id").unwrap();
        assert_eq!(cmd, r"claude --resume 'weird'\''id'");
    }

    // ---- preexisting tests below ------------------------------------

    // ---- model overrides --------------------------------------------

    fn override_(model: &str, effort: Option<&str>) -> ModelOverride {
        ModelOverride {
            model: model.to_string(),
            effort: effort.map(|s| s.to_string()),
        }
    }

    #[test]
    fn claude_override_injects_model_and_effort() {
        let cmd = harness_launch_command_with_prompt_and_override(
            AgentKind::ClaudeCode,
            None,
            None,
            Some("review"),
            Some(&override_("opus", Some("high"))),
        )
        .unwrap();
        assert_eq!(cmd, "claude --model 'opus' --effort 'high' 'review'");
    }

    #[test]
    fn claude_override_skips_when_user_pinned_model() {
        let cmd = harness_launch_command_with_prompt_and_override(
            AgentKind::ClaudeCode,
            Some("--model claude-sonnet-4-6"),
            None,
            None,
            Some(&override_("opus", Some("high"))),
        )
        .unwrap();
        // user's --model wins; --effort still injected (no conflict)
        assert_eq!(cmd, "claude --effort 'high' --model claude-sonnet-4-6");
    }

    #[test]
    fn claude_override_skips_when_user_pinned_effort() {
        let cmd = harness_launch_command_with_prompt_and_override(
            AgentKind::ClaudeCode,
            Some("--effort low --verbose"),
            None,
            None,
            Some(&override_("opus", Some("high"))),
        )
        .unwrap();
        assert_eq!(cmd, "claude --model 'opus' --effort low --verbose");
    }

    #[test]
    fn claude_override_no_effort_only_model() {
        let cmd = harness_launch_command_with_prompt_and_override(
            AgentKind::ClaudeCode,
            None,
            None,
            None,
            Some(&override_("claude-opus-4-7", None)),
        )
        .unwrap();
        assert_eq!(cmd, "claude --model 'claude-opus-4-7'");
    }

    #[test]
    fn codex_override_injects_model_and_effort_via_c_flag() {
        let cmd = harness_launch_command_with_prompt_and_override(
            AgentKind::Codex,
            None,
            None,
            Some("brief"),
            Some(&override_("gpt-5.4", Some("high"))),
        )
        .unwrap();
        // Effort goes through `-c key=value` and lands AFTER the prompt would
        // be wrong; verify it lands before the prompt arg.
        assert_eq!(
            cmd,
            "codex -m 'gpt-5.4' -c model_reasoning_effort=high 'brief'"
        );
    }

    #[test]
    fn codex_override_skips_when_user_already_pinned_dash_m() {
        let cmd = harness_launch_command_with_prompt_and_override(
            AgentKind::Codex,
            Some("-m gpt-5.3-codex"),
            None,
            None,
            Some(&override_("gpt-5.4", Some("high"))),
        )
        .unwrap();
        assert_eq!(cmd, "codex -m gpt-5.3-codex -c model_reasoning_effort=high");
    }

    #[test]
    fn codex_override_skips_when_user_already_pinned_long_model() {
        let cmd = harness_launch_command_with_prompt_and_override(
            AgentKind::Codex,
            Some("--model gpt-5.3-codex"),
            None,
            None,
            Some(&override_("gpt-5.4", None)),
        )
        .unwrap();
        assert_eq!(cmd, "codex --model gpt-5.3-codex");
    }

    #[test]
    fn codex_override_skips_when_user_already_set_effort_via_c() {
        let cmd = harness_launch_command_with_prompt_and_override(
            AgentKind::Codex,
            Some("-c model_reasoning_effort=low"),
            None,
            None,
            Some(&override_("gpt-5.4", Some("high"))),
        )
        .unwrap();
        assert_eq!(cmd, "codex -m 'gpt-5.4' -c model_reasoning_effort=low");
    }

    #[test]
    fn opencode_override_injects_model_only() {
        let cmd = harness_launch_command_with_prompt_and_override(
            AgentKind::OpenCode,
            None,
            Some(45123),
            Some("brief"),
            Some(&override_("github-copilot/claude-opus-4.7", Some("high"))),
        )
        .unwrap();
        // Effort intentionally ignored for OpenCode in v1.
        assert_eq!(
            cmd,
            "opencode --port 45123 --model 'github-copilot/claude-opus-4.7'"
        );
        assert!(!cmd.contains("effort"));
    }

    #[test]
    fn opencode_override_skips_when_user_already_pinned() {
        let cmd = harness_launch_command_with_prompt_and_override(
            AgentKind::OpenCode,
            Some("--model openai/gpt-5"),
            Some(45123),
            None,
            Some(&override_("github-copilot/claude-opus-4.7", None)),
        )
        .unwrap();
        assert_eq!(cmd, "opencode --port 45123 --model openai/gpt-5");
    }

    #[test]
    fn shell_returns_none_with_override() {
        let cmd = harness_launch_command_with_prompt_and_override(
            AgentKind::Shell,
            None,
            None,
            None,
            Some(&override_("opus", None)),
        );
        assert!(cmd.is_none());
    }

    #[test]
    fn empty_model_override_no_op() {
        // Empty/whitespace model id should be treated as "no override" so the
        // backwards-compatible behaviour matches `harness_launch_command_with_prompt`.
        let cmd = harness_launch_command_with_prompt_and_override(
            AgentKind::ClaudeCode,
            None,
            None,
            None,
            Some(&override_("   ", Some(""))),
        )
        .unwrap();
        assert_eq!(cmd, "claude");
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
