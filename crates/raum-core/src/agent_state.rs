//! Agent state machine (§7.7).
//!
//! Drives `{Idle, Working, Waiting, Completed, Errored}` transitions from hook
//! events (Claude Code, OpenCode) or Codex JSON stream events, with a silence
//! heuristic fallback per harness.
//!
//! The machine is intentionally synchronous and pure — the broadcast plumbing
//! to the Tauri webview lives one layer up (see `src-tauri/src/commands/agent.rs`).

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::agent::{AgentKind, AgentState, SessionId};
use crate::config::DEFAULT_SILENCE_THRESHOLD_MS;
use crate::harness::{Reliability, classify_notification_event, classify_notification_kind};

/// Hook event shape consumed by the state machine.
///
/// Structurally identical to `raum_hooks::HookEvent`; duplicated here to avoid
/// a dependency cycle between `raum-core` and `raum-hooks` (the latter already
/// depends on `AgentKind` from `raum-core`). The `src-tauri` layer performs
/// the trivial `From<raum_hooks::HookEvent>` conversion at the adapter edge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookEvent {
    pub harness: String,
    pub event: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub reliability: Option<Reliability>,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// A state transition record that can be re-emitted onto the Tauri event bus
/// (`agent-state-changed`, §7.8).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgentStateChanged {
    pub session_id: SessionId,
    pub harness: AgentKind,
    pub from: AgentState,
    pub to: AgentState,
    /// How confident we are in the transition. Replaces the previous
    /// `via_silence_heuristic: bool` flag (per-harness notification plan,
    /// Phase 1). `Deterministic` / `EventDriven` transitions came from a
    /// harness-native signal (hook, SSE, OSC); `Heuristic` transitions
    /// came from the silence fallback in `tick_silence`.
    pub reliability: Reliability,
}

/// The user's most recently submitted prompt for a session. Captured from
/// `UserPromptSubmit` hook payloads (Claude Code, Codex) and from the
/// equivalent SSE event (OpenCode). Truncated to [`MAX_PROMPT_BYTES`] at
/// write time so a giant pasted brief doesn't bloat the IPC bus or the
/// session TOML.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptEntry {
    pub text: String,
    pub submitted_at_ms: u64,
}

/// Sibling to [`AgentStateChanged`] — re-emitted onto the Tauri webview
/// as `pane:prompt-updated` so the tab can render the latest user prompt
/// as a subtitle row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PromptUpdated {
    pub session_id: SessionId,
    pub harness: AgentKind,
    pub text: String,
    pub submitted_at_ms: u64,
}

/// Hard cap on the bytes we store / forward for a single prompt. The UI
/// truncates further for display; this cap exists so a 1 MB pasted brief
/// can't repeatedly cross the IPC boundary or balloon the persisted TOML.
pub const MAX_PROMPT_BYTES: usize = 4096;

/// UTF-8 safe truncation. If `text` is longer than [`MAX_PROMPT_BYTES`]
/// bytes, drops bytes from the end at the previous char boundary and
/// appends an ellipsis.
#[must_use]
pub fn truncate_prompt(text: &str) -> String {
    if text.len() <= MAX_PROMPT_BYTES {
        return text.to_string();
    }
    let mut end = MAX_PROMPT_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = String::with_capacity(end + 3);
    out.push_str(&text[..end]);
    out.push('…');
    out
}

/// Pull the user's prompt text out of a harness-specific hook payload.
/// Returns `None` for harnesses without a known field (e.g. `Shell`) or
/// when the field is missing.
///
/// * Claude Code emits `{ "prompt": "...", ... }` to the
///   `UserPromptSubmit` hook on stdin.
/// * Codex emits the same field for its `UserPromptSubmit` hook;
///   `user_message` and `message` are accepted as fallbacks because the
///   Codex hook payload schema has shifted between minor versions.
/// * OpenCode does not flow through this helper — its prompts come off
///   the SSE bus and are recorded directly via `record_user_prompt`.
#[must_use]
pub fn extract_user_prompt(harness: AgentKind, payload: &serde_json::Value) -> Option<String> {
    let candidate = match harness {
        AgentKind::ClaudeCode => payload.get("prompt"),
        AgentKind::Codex => payload
            .get("prompt")
            .or_else(|| payload.get("user_message"))
            .or_else(|| payload.get("message")),
        // OpenCode prompts arrive over SSE; the channel synthesises a
        // `UserPromptSubmit` wire event with `payload.prompt` set, so the
        // same drain path handles all three harnesses uniformly.
        AgentKind::OpenCode => payload.get("prompt"),
        AgentKind::Shell => None,
    };
    candidate
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

#[derive(Debug, Clone)]
pub struct AgentStateMachine {
    session_id: SessionId,
    harness: AgentKind,
    state: AgentState,
    silence_threshold: Duration,
    /// When true, native hook/SSE events are unavailable, so hook events are
    /// treated purely as generic activity and silence/output heuristics carry
    /// more of the lifecycle.
    silence_only: bool,
    /// Gates output-driven heuristic promotions so startup banners, attach
    /// redraws, and other bootstrap bytes do not count as a real turn.
    ///
    /// Armed by an explicit turn-start event, or by `terminal_send_keys`
    /// after the user submits input. Cleared by explicit "needs input" /
    /// turn-end / error signals so stale trailing output cannot immediately
    /// reclaim `Working`.
    activity_armed: bool,
    /// Most recent user-submitted prompt for this session. Replaced
    /// in-place on each new submit; surfaced to the UI as the tab
    /// subtitle.
    last_prompt: Option<PromptEntry>,
}

impl AgentStateMachine {
    #[must_use]
    pub fn new(session_id: SessionId, harness: AgentKind) -> Self {
        Self {
            session_id,
            harness,
            state: AgentState::Idle,
            silence_threshold: Duration::from_millis(DEFAULT_SILENCE_THRESHOLD_MS),
            silence_only: false,
            activity_armed: false,
            last_prompt: None,
        }
    }

    #[must_use]
    pub fn with_silence_threshold(mut self, threshold: Duration) -> Self {
        self.silence_threshold = threshold;
        self
    }

    /// Seed the machine with a non-Idle starting state. Used on reattach
    /// to restore the last persisted harness state so a waiting prompt or
    /// in-flight turn survives an app restart. Downstream transitions
    /// operate on whatever the current state is, so no invariants break.
    #[must_use]
    pub fn with_initial_state(mut self, state: AgentState) -> Self {
        self.state = state;
        self
    }

    /// Switch to silence-heuristic-only mode for this harness. Used when the
    /// hooks dir is not writable (`HookScriptError::NotWritable`, §7.11).
    pub fn set_silence_only(&mut self, yes: bool) {
        self.silence_only = yes;
    }

    /// Arm output-driven heuristics for a future turn. Called after a real
    /// user submit so subsequent PTY bytes can promote
    /// `Idle`/`Waiting`/`Completed` → `Working` without counting startup
    /// output or attach redraws.
    pub fn arm_activity(&mut self) {
        self.activity_armed = true;
    }

    #[must_use]
    pub fn activity_armed(&self) -> bool {
        self.activity_armed
    }

    #[must_use]
    pub fn is_silence_only(&self) -> bool {
        self.silence_only
    }

    #[must_use]
    pub fn state(&self) -> AgentState {
        self.state
    }

    #[must_use]
    pub fn harness(&self) -> AgentKind {
        self.harness
    }

    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    #[must_use]
    pub fn silence_threshold(&self) -> Duration {
        self.silence_threshold
    }

    #[must_use]
    pub fn last_prompt(&self) -> Option<&PromptEntry> {
        self.last_prompt.as_ref()
    }

    /// Seed the machine with a previously-persisted prompt so a freshly
    /// rehydrated session shows the same context the user left behind.
    pub fn seed_last_prompt(&mut self, entry: PromptEntry) {
        self.last_prompt = Some(entry);
    }

    /// Record a user submit. Replaces the stored prompt, returning a
    /// [`PromptUpdated`] record the caller can broadcast on the bus. The
    /// state machine itself is not transitioned by this call — callers
    /// pair it with `on_hook_event(UserPromptSubmit)` for the state side.
    pub fn record_user_prompt(&mut self, text: String, submitted_at_ms: u64) -> PromptUpdated {
        let entry = PromptEntry {
            text: truncate_prompt(&text),
            submitted_at_ms,
        };
        self.last_prompt = Some(entry.clone());
        PromptUpdated {
            session_id: self.session_id.clone(),
            harness: self.harness,
            text: entry.text,
            submitted_at_ms: entry.submitted_at_ms,
        }
    }

    /// Apply a hook event. Returns `Some(change)` if the state advanced.
    pub fn on_hook_event(&mut self, ev: &HookEvent) -> Option<AgentStateChanged> {
        let reliability = ev.reliability.unwrap_or(Reliability::Deterministic);
        // SessionStart fires at harness boot before a user has typed
        // anything. Arm output-based recovery so subsequent real PTY
        // activity can flip Idle → Working, but do not force a transition
        // here — the classifier deliberately returns None for this event.
        if ev.event == "SessionStart" {
            self.arm_activity();
        }
        if self.silence_only {
            // In fallback mode, the only signal is silence. Treat hook events
            // purely as "activity" → Working. The transition itself is still
            // deterministic (we saw a real hook fire) even though the
            // downstream Waiting transition will be heuristic. SessionStart
            // is the one exception: we still only want to arm activity, not
            // immediately promote to Working, or every pane would look busy
            // the instant it boots.
            if ev.event == "SessionStart" {
                return None;
            }
            self.arm_activity();
            return self.transition(AgentState::Working, reliability);
        }
        let kind = classify_notification_event(
            self.harness,
            &ev.event,
            ev.source.as_deref(),
            &ev.payload,
        )?;
        self.apply_notification_kind(kind, reliability)
    }

    /// Apply a Codex-stream event. The `event` name space is the same as
    /// `HookEvent::event` so we delegate.
    pub fn on_codex_event(&mut self, event_name: &str) -> Option<AgentStateChanged> {
        if event_name == "SessionStart" {
            self.arm_activity();
        }
        let kind = classify_notification_kind(event_name)?;
        self.apply_notification_kind(kind, Reliability::Deterministic)
    }

    /// User answered a permission prompt (via raum's UI reply_permission
    /// or by answering directly in the harness TUI after a hook timeout).
    /// The harness is about to resume real work, so demote Waiting →
    /// Working with `EventDriven` reliability. Re-arms activity so any
    /// silent tail of PTY bytes is treated as real turn output.
    ///
    /// Only Waiting demotes — `Completed` / `Errored` are terminal;
    /// `Idle` / `Working` are already past the prompt.
    pub fn on_permission_reply(&mut self) -> Option<AgentStateChanged> {
        if self.state != AgentState::Waiting {
            return None;
        }
        self.activity_armed = true;
        self.transition(AgentState::Working, Reliability::EventDriven)
    }

    /// User pressed the abort key (Ctrl-C) in the terminal pane. No harness
    /// currently emits a "turn aborted" hook, so raum synthesises this
    /// transition from the send-keys interceptor. Working/Waiting → Idle.
    /// Idle / Completed / Errored are left alone.
    pub fn on_user_abort(&mut self) -> Option<AgentStateChanged> {
        match self.state {
            AgentState::Working | AgentState::Waiting => {
                self.activity_armed = false;
                self.transition(AgentState::Idle, Reliability::EventDriven)
            }
            _ => None,
        }
    }

    /// Activity/silence heuristic tick. The caller supplies the age of the
    /// last stdout chunk observed on the pane.
    ///
    /// Semantics:
    /// * `Waiting` is the "harness is asking the user for input" signal and
    ///   is **only** set by deterministic hook/SSE events (see
    ///   [`classify_hook_event`]). The silence heuristic never promotes
    ///   anything to `Waiting` — it can't distinguish "quiet because
    ///   waiting" from "quiet because done".
    /// * Any recent PTY output is treated as activity → `Working`, so a
    ///   machine in `Idle`, `Waiting`, or `Completed` flips back to
    ///   `Working` as soon as bytes flow again after the user has submitted
    ///   a new turn or a start-hook armed the machine.
    /// * Stale output on a `Working` machine demotes it to `Idle` for every
    ///   harness. This is the fallback when a deterministic turn-end signal
    ///   is missed; the threshold is deliberately generous so a silent think
    ///   does not flap.
    ///
    /// `Errored` remains terminal.
    pub fn tick_silence(&mut self, last_output_age: Duration) -> Option<AgentStateChanged> {
        let recent = last_output_age < self.silence_threshold;
        match self.state {
            AgentState::Idle | AgentState::Waiting | AgentState::Completed
                if recent && self.activity_armed =>
            {
                self.transition(AgentState::Working, Reliability::Heuristic)
            }
            AgentState::Working if !recent => {
                self.transition(AgentState::Idle, Reliability::Heuristic)
            }
            _ => None,
        }
    }

    fn apply_notification_kind(
        &mut self,
        kind: crate::harness::NotificationKind,
        reliability: Reliability,
    ) -> Option<AgentStateChanged> {
        match kind {
            crate::harness::NotificationKind::TurnStart => self.activity_armed = true,
            crate::harness::NotificationKind::PermissionNeeded
            | crate::harness::NotificationKind::IdlePromptNeeded
            | crate::harness::NotificationKind::TurnEnd
            | crate::harness::NotificationKind::Error => {
                self.activity_armed = false;
            }
        }
        self.transition(kind.target_state(), reliability)
    }

    fn transition(
        &mut self,
        next: AgentState,
        reliability: Reliability,
    ) -> Option<AgentStateChanged> {
        if next == self.state {
            return None;
        }
        let from = self.state;
        self.state = next;
        Some(AgentStateChanged {
            session_id: self.session_id.clone(),
            harness: self.harness,
            from,
            to: next,
            reliability,
        })
    }
}

/// Per-session silence threshold overrides (maps a harness name → millis).
///
/// Used by callers that want to apply per-harness thresholds coming from
/// `~/.config/raum/config.toml` `agent_defaults.silence_threshold_ms`.
#[must_use]
pub fn resolve_silence_threshold(
    harness: AgentKind,
    overrides: &BTreeMap<String, u64>,
) -> Duration {
    let key = match harness {
        AgentKind::Shell => "shell",
        AgentKind::ClaudeCode => "claude-code",
        AgentKind::Codex => "codex",
        AgentKind::OpenCode => "opencode",
    };
    if let Some(ms) = overrides.get(key) {
        return Duration::from_millis(*ms);
    }
    Duration::from_millis(DEFAULT_SILENCE_THRESHOLD_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sm() -> AgentStateMachine {
        AgentStateMachine::new(SessionId::new("raum-abc"), AgentKind::ClaudeCode)
    }

    fn ev(name: &str) -> HookEvent {
        HookEvent {
            harness: "claude-code".into(),
            event: name.into(),
            source: None,
            reliability: None,
            payload: serde_json::Value::Null,
        }
    }

    #[test]
    fn starts_idle() {
        assert_eq!(sm().state(), AgentState::Idle);
    }

    #[test]
    fn with_initial_state_seeds_and_accepts_transitions() {
        let mut m = AgentStateMachine::new(SessionId::new("raum-seed"), AgentKind::ClaudeCode)
            .with_initial_state(AgentState::Waiting);
        assert_eq!(m.state(), AgentState::Waiting);

        // A subsequent Stop hook should transition Waiting -> Completed via
        // the same path as any other transition — the seed doesn't wedge the
        // machine.
        let change = m.on_hook_event(&ev("Stop")).unwrap();
        assert_eq!(change.from, AgentState::Waiting);
        assert_eq!(change.to, AgentState::Completed);
        assert_eq!(m.state(), AgentState::Completed);
    }

    #[test]
    fn user_prompt_submit_moves_to_working() {
        let mut m = sm();
        let change = m.on_hook_event(&ev("UserPromptSubmit")).unwrap();
        assert_eq!(change.from, AgentState::Idle);
        assert_eq!(change.to, AgentState::Working);
        assert_eq!(m.state(), AgentState::Working);
    }

    #[test]
    fn notification_moves_to_waiting() {
        let mut m = sm();
        m.on_hook_event(&ev("UserPromptSubmit"));
        let change = m
            .on_hook_event(&HookEvent {
                payload: serde_json::json!({ "notification_type": "elicitation_dialog" }),
                ..ev("Notification")
            })
            .unwrap();
        assert_eq!(change.to, AgentState::Waiting);
        assert_eq!(change.reliability, Reliability::Deterministic);
    }

    #[test]
    fn claude_idle_prompt_after_stop_keeps_completed() {
        // Regression: Claude fires `Notification { notification_type: idle_prompt }`
        // after the prompt has been idle for a while, which used to flip a
        // Completed pane back to Waiting and emit a second "attention"
        // notification on top of the "Finished" one.
        let mut m = sm();
        m.on_hook_event(&ev("UserPromptSubmit"));
        m.on_hook_event(&ev("Stop"));
        assert_eq!(m.state(), AgentState::Completed);
        let change = m.on_hook_event(&HookEvent {
            payload: serde_json::json!({ "notification_type": "idle_prompt" }),
            ..ev("Notification")
        });
        assert!(change.is_none(), "idle_prompt must not change state");
        assert_eq!(m.state(), AgentState::Completed);
    }

    #[test]
    fn claude_permission_prompt_notification_is_ignored() {
        // The synchronous `PermissionRequest` hook is what promotes to
        // Waiting; the non-blocking `Notification { notification_type:
        // permission_prompt }` echo must not drive a transition on its own.
        let mut m = sm();
        m.on_hook_event(&ev("UserPromptSubmit"));
        let change = m.on_hook_event(&HookEvent {
            payload: serde_json::json!({ "notification_type": "permission_prompt" }),
            ..ev("Notification")
        });
        assert!(change.is_none());
        assert_eq!(m.state(), AgentState::Working);
    }

    #[test]
    fn claude_auth_success_is_ignored() {
        let mut m = sm();
        m.on_hook_event(&ev("UserPromptSubmit"));
        let change = m.on_hook_event(&HookEvent {
            payload: serde_json::json!({ "notification_type": "auth_success" }),
            ..ev("Notification")
        });
        assert!(change.is_none());
        assert_eq!(m.state(), AgentState::Working);
    }

    #[test]
    fn stop_moves_to_completed() {
        let mut m = sm();
        m.on_hook_event(&ev("UserPromptSubmit"));
        let change = m.on_hook_event(&ev("Stop")).unwrap();
        assert_eq!(change.to, AgentState::Completed);
    }

    #[test]
    fn error_event_moves_to_errored() {
        let mut m = sm();
        m.on_hook_event(&ev("UserPromptSubmit"));
        let change = m.on_hook_event(&ev("Error")).unwrap();
        assert_eq!(change.to, AgentState::Errored);
    }

    #[test]
    fn permission_request_moves_to_waiting() {
        let mut m = sm();
        let change = m.on_hook_event(&ev("PermissionRequest")).unwrap();
        assert_eq!(change.to, AgentState::Waiting);
    }

    #[test]
    fn stop_failure_moves_to_errored() {
        let mut m = sm();
        m.on_hook_event(&ev("UserPromptSubmit"));
        let change = m.on_hook_event(&ev("StopFailure")).unwrap();
        assert_eq!(change.to, AgentState::Errored);
    }

    #[test]
    fn codex_notify_turn_complete_moves_to_completed() {
        let mut m = AgentStateMachine::new(SessionId::new("raum-codex"), AgentKind::Codex);
        m.on_hook_event(&HookEvent {
            harness: "codex".into(),
            event: "UserPromptSubmit".into(),
            source: None,
            reliability: None,
            payload: serde_json::Value::Null,
        });
        let change = m
            .on_hook_event(&HookEvent {
                harness: "codex".into(),
                event: "Notification".into(),
                source: Some("notify".into()),
                reliability: Some(Reliability::EventDriven),
                payload: serde_json::json!({ "type": "agent-turn-complete" }),
            })
            .unwrap();
        assert_eq!(change.to, AgentState::Completed);
        assert_eq!(change.reliability, Reliability::EventDriven);
    }

    #[test]
    fn repeated_event_is_noop() {
        let mut m = sm();
        let first = m.on_hook_event(&ev("UserPromptSubmit"));
        let second = m.on_hook_event(&ev("UserPromptSubmit"));
        assert!(first.is_some());
        assert!(second.is_none());
    }

    #[test]
    fn silence_demotes_working_to_idle_when_hooks_live() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(100));
        m.on_hook_event(&ev("UserPromptSubmit"));
        // Below threshold: no transition.
        assert!(m.tick_silence(Duration::from_millis(50)).is_none());
        let change = m.tick_silence(Duration::from_secs(60)).unwrap();
        assert_eq!(change.from, AgentState::Working);
        assert_eq!(change.to, AgentState::Idle);
        assert_eq!(change.reliability, Reliability::Heuristic);
        assert_eq!(m.state(), AgentState::Idle);
    }

    #[test]
    fn silence_demotes_working_to_idle_in_silence_only_fallback() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(100));
        m.set_silence_only(true);
        // In fallback mode any hook event counts as activity → Working.
        m.on_hook_event(&ev("UserPromptSubmit"));
        assert_eq!(m.state(), AgentState::Working);
        // Below threshold: no transition.
        assert!(m.tick_silence(Duration::from_millis(50)).is_none());
        // At / above threshold: → Idle — the only end-of-turn signal we have.
        let change = m.tick_silence(Duration::from_millis(150)).unwrap();
        assert_eq!(change.from, AgentState::Working);
        assert_eq!(change.to, AgentState::Idle);
        assert_eq!(change.reliability, Reliability::Heuristic);
    }

    #[test]
    fn stale_idle_does_not_transition() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(500));
        // Age well past the threshold — no recent activity, stay Idle.
        assert!(m.tick_silence(Duration::from_secs(10)).is_none());
        assert_eq!(m.state(), AgentState::Idle);
    }

    #[test]
    fn silence_is_ignored_in_terminal_states_without_activity_arm() {
        let mut m = sm();
        m.on_hook_event(&ev("UserPromptSubmit"));
        m.on_hook_event(&ev("Stop"));
        assert_eq!(m.state(), AgentState::Completed);
        // Completed stays quiescent until a future submit arms activity
        // recovery; Errored remains terminal.
        assert!(m.tick_silence(Duration::from_millis(10)).is_none());
        assert!(m.tick_silence(Duration::from_secs(10)).is_none());
        assert_eq!(m.state(), AgentState::Completed);
    }

    #[test]
    fn errored_state_remains_terminal() {
        let mut m = sm();
        m.on_hook_event(&ev("UserPromptSubmit"));
        m.on_hook_event(&ev("Error"));
        assert_eq!(m.state(), AgentState::Errored);
        m.arm_activity();
        assert!(m.tick_silence(Duration::from_millis(10)).is_none());
        assert!(m.tick_silence(Duration::from_secs(10)).is_none());
        assert_eq!(m.state(), AgentState::Errored);
    }

    #[test]
    fn recent_activity_does_not_promote_fresh_idle_without_arm() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(500));
        assert!(m.tick_silence(Duration::from_millis(50)).is_none());
        assert_eq!(m.state(), AgentState::Idle);
    }

    #[test]
    fn armed_recent_activity_promotes_idle_to_working() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(500));
        m.arm_activity();
        let change = m.tick_silence(Duration::from_millis(50)).unwrap();
        assert_eq!(change.from, AgentState::Idle);
        assert_eq!(change.to, AgentState::Working);
        assert_eq!(change.reliability, Reliability::Heuristic);
        assert_eq!(m.state(), AgentState::Working);
    }

    #[test]
    fn armed_recent_activity_reclaims_waiting_to_working() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(500));
        m.on_hook_event(&ev("UserPromptSubmit"));
        m.on_hook_event(&HookEvent {
            payload: serde_json::json!({ "notification_type": "elicitation_dialog" }),
            ..ev("Notification")
        });
        assert_eq!(m.state(), AgentState::Waiting);
        // The user submitted a new turn but the follow-up start hook was
        // missed, so fresh PTY bytes are now allowed to reclaim Working.
        m.arm_activity();
        let change = m.tick_silence(Duration::from_millis(10)).unwrap();
        assert_eq!(change.from, AgentState::Waiting);
        assert_eq!(change.to, AgentState::Working);
        assert_eq!(change.reliability, Reliability::Heuristic);
    }

    #[test]
    fn armed_recent_activity_reclaims_completed_to_working() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(500));
        m.on_hook_event(&ev("UserPromptSubmit"));
        m.on_hook_event(&ev("Stop"));
        assert_eq!(m.state(), AgentState::Completed);
        m.arm_activity();
        let change = m.tick_silence(Duration::from_millis(10)).unwrap();
        assert_eq!(change.from, AgentState::Completed);
        assert_eq!(change.to, AgentState::Working);
        assert_eq!(change.reliability, Reliability::Heuristic);
    }

    #[test]
    fn waiting_clears_activity_arm() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(500));
        m.on_hook_event(&ev("UserPromptSubmit"));
        assert!(m.activity_armed());
        m.on_hook_event(&HookEvent {
            payload: serde_json::json!({ "notification_type": "elicitation_dialog" }),
            ..ev("Notification")
        });
        assert!(!m.activity_armed());
        assert!(m.tick_silence(Duration::from_millis(10)).is_none());
        assert_eq!(m.state(), AgentState::Waiting);
    }

    #[test]
    fn stale_waiting_stays_waiting() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(100));
        m.on_hook_event(&ev("UserPromptSubmit"));
        m.on_hook_event(&HookEvent {
            payload: serde_json::json!({ "notification_type": "elicitation_dialog" }),
            ..ev("Notification")
        });
        // Harness is quiet and deterministically waiting — silence tick must
        // not demote it. Only a new event or fresh PTY activity can move it.
        assert!(m.tick_silence(Duration::from_secs(10)).is_none());
        assert_eq!(m.state(), AgentState::Waiting);
    }

    #[test]
    fn codex_event_classifies_like_hook_event() {
        let mut m = AgentStateMachine::new(SessionId::new("s"), AgentKind::Codex);
        assert_eq!(
            m.on_codex_event("UserPromptSubmit").unwrap().to,
            AgentState::Working
        );
        assert_eq!(
            m.on_codex_event("Notification").unwrap().to,
            AgentState::Waiting
        );
    }

    #[test]
    fn session_start_does_not_leave_idle() {
        let mut m = sm();
        assert!(m.on_hook_event(&ev("SessionStart")).is_none());
        assert_eq!(m.state(), AgentState::Idle);
    }

    #[test]
    fn session_start_arms_activity_for_output_recovery() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(500));
        m.on_hook_event(&ev("SessionStart"));
        assert!(m.activity_armed());
        // Recent PTY output after SessionStart should be able to promote
        // Idle → Working through the normal heuristic path.
        let change = m.tick_silence(Duration::from_millis(10)).unwrap();
        assert_eq!(change.from, AgentState::Idle);
        assert_eq!(change.to, AgentState::Working);
    }

    #[test]
    fn session_start_then_user_prompt_transitions_from_idle() {
        let mut m = sm();
        m.on_hook_event(&ev("SessionStart"));
        let change = m.on_hook_event(&ev("UserPromptSubmit")).unwrap();
        assert_eq!(change.from, AgentState::Idle);
        assert_eq!(change.to, AgentState::Working);
    }

    #[test]
    fn silence_only_session_start_still_stays_idle() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(100));
        m.set_silence_only(true);
        assert!(m.on_hook_event(&ev("SessionStart")).is_none());
        assert_eq!(m.state(), AgentState::Idle);
        // But the machine is now armed so fresh output promotes to Working.
        let change = m.tick_silence(Duration::from_millis(10)).unwrap();
        assert_eq!(change.to, AgentState::Working);
    }

    #[test]
    fn permission_reply_moves_waiting_to_working() {
        let mut m = sm();
        m.on_hook_event(&ev("PermissionRequest"));
        assert_eq!(m.state(), AgentState::Waiting);
        let change = m.on_permission_reply().unwrap();
        assert_eq!(change.from, AgentState::Waiting);
        assert_eq!(change.to, AgentState::Working);
        assert_eq!(change.reliability, Reliability::EventDriven);
        assert!(m.activity_armed());
    }

    #[test]
    fn permission_reply_is_noop_outside_waiting() {
        let mut m = sm();
        assert!(m.on_permission_reply().is_none());
        m.on_hook_event(&ev("UserPromptSubmit"));
        assert_eq!(m.state(), AgentState::Working);
        assert!(m.on_permission_reply().is_none());
    }

    #[test]
    fn consecutive_permission_requests_emit_transitions_after_reply() {
        let mut m = sm();
        // First permission arrives — Idle → Waiting.
        let first = m.on_hook_event(&ev("PermissionRequest")).unwrap();
        assert_eq!(first.to, AgentState::Waiting);
        // User replies → Waiting → Working (the fix: without this the
        // second PermissionRequest below would be Waiting → Waiting = no-op
        // and the UI would never re-highlight).
        let reply = m.on_permission_reply().unwrap();
        assert_eq!(reply.to, AgentState::Working);
        // Second permission arrives — now Working → Waiting emits.
        let second = m.on_hook_event(&ev("PermissionRequest")).unwrap();
        assert_eq!(second.from, AgentState::Working);
        assert_eq!(second.to, AgentState::Waiting);
    }

    #[test]
    fn abort_from_working_goes_idle() {
        let mut m = sm();
        m.on_hook_event(&ev("UserPromptSubmit"));
        assert_eq!(m.state(), AgentState::Working);
        let change = m.on_user_abort().unwrap();
        assert_eq!(change.from, AgentState::Working);
        assert_eq!(change.to, AgentState::Idle);
        assert_eq!(change.reliability, Reliability::EventDriven);
        assert!(!m.activity_armed());
    }

    #[test]
    fn abort_from_waiting_goes_idle() {
        let mut m = sm();
        m.on_hook_event(&ev("PermissionRequest"));
        assert_eq!(m.state(), AgentState::Waiting);
        let change = m.on_user_abort().unwrap();
        assert_eq!(change.from, AgentState::Waiting);
        assert_eq!(change.to, AgentState::Idle);
    }

    #[test]
    fn abort_from_idle_is_noop() {
        let mut m = sm();
        assert!(m.on_user_abort().is_none());
        assert_eq!(m.state(), AgentState::Idle);
    }

    #[test]
    fn abort_from_completed_is_noop() {
        let mut m = sm();
        m.on_hook_event(&ev("UserPromptSubmit"));
        m.on_hook_event(&ev("Stop"));
        assert_eq!(m.state(), AgentState::Completed);
        assert!(m.on_user_abort().is_none());
    }

    #[test]
    fn abort_from_errored_is_noop() {
        let mut m = sm();
        m.on_hook_event(&ev("UserPromptSubmit"));
        m.on_hook_event(&ev("Error"));
        assert_eq!(m.state(), AgentState::Errored);
        assert!(m.on_user_abort().is_none());
    }

    #[test]
    fn abort_clears_activity_arm_so_trailing_output_cannot_reclaim() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(500));
        m.on_hook_event(&ev("UserPromptSubmit"));
        assert!(m.activity_armed());
        m.on_user_abort();
        assert!(!m.activity_armed());
        // A stray PTY chunk arriving immediately after must not promote
        // back to Working — the user explicitly signalled they're done.
        assert!(m.tick_silence(Duration::from_millis(10)).is_none());
        assert_eq!(m.state(), AgentState::Idle);
    }

    #[test]
    fn codex_session_start_does_not_leave_idle() {
        let mut m = AgentStateMachine::new(SessionId::new("s"), AgentKind::Codex);
        assert!(m.on_codex_event("SessionStart").is_none());
        assert_eq!(m.state(), AgentState::Idle);
        assert!(m.activity_armed());
    }

    #[test]
    fn silence_only_fallback_treats_hooks_as_activity() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(100));
        m.set_silence_only(true);
        // Any hook event → Working, regardless of the event name.
        let change = m.on_hook_event(&ev("Notification")).unwrap();
        assert_eq!(change.to, AgentState::Working);
    }

    #[test]
    fn opencode_sse_notification_enters_waiting() {
        let mut m = AgentStateMachine::new(SessionId::new("raum-open"), AgentKind::OpenCode);
        let change = m
            .on_hook_event(&HookEvent {
                harness: "opencode".into(),
                event: "Notification".into(),
                source: Some("opencode-sse".into()),
                reliability: Some(Reliability::Deterministic),
                payload: serde_json::json!({
                    "id": "q-1",
                    "sessionID": "raum-open",
                    "questions": []
                }),
            })
            .unwrap();
        assert_eq!(change.to, AgentState::Waiting);
        assert_eq!(m.state(), AgentState::Waiting);
    }

    #[test]
    fn silence_only_idle_requires_submit_arm_before_recent_output() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(100));
        m.set_silence_only(true);
        assert!(m.tick_silence(Duration::from_millis(10)).is_none());
        m.arm_activity();
        let change = m.tick_silence(Duration::from_millis(10)).unwrap();
        assert_eq!(change.to, AgentState::Working);
    }

    #[test]
    fn silence_only_idle_demote_keeps_activity_arm_for_future_output() {
        let mut m = sm().with_silence_threshold(Duration::from_millis(100));
        m.set_silence_only(true);
        m.arm_activity();
        m.tick_silence(Duration::from_millis(10));
        let change = m.tick_silence(Duration::from_millis(150)).unwrap();
        assert_eq!(change.to, AgentState::Idle);
        assert!(m.activity_armed());
        let reclaimed = m.tick_silence(Duration::from_millis(10)).unwrap();
        assert_eq!(reclaimed.to, AgentState::Working);
    }

    #[test]
    fn resolve_silence_threshold_uses_default_when_missing() {
        let empty = BTreeMap::new();
        let d = resolve_silence_threshold(AgentKind::ClaudeCode, &empty);
        assert_eq!(d, Duration::from_millis(DEFAULT_SILENCE_THRESHOLD_MS));
    }

    #[test]
    fn resolve_silence_threshold_honors_override() {
        let mut m = BTreeMap::new();
        m.insert("codex".into(), 2000u64);
        let d = resolve_silence_threshold(AgentKind::Codex, &m);
        assert_eq!(d, Duration::from_secs(2));
    }

    #[test]
    fn extract_user_prompt_claude() {
        let payload = serde_json::json!({ "session_id": "s", "prompt": "refactor session.ts" });
        assert_eq!(
            extract_user_prompt(AgentKind::ClaudeCode, &payload).as_deref(),
            Some("refactor session.ts")
        );
    }

    #[test]
    fn extract_user_prompt_codex_fallbacks() {
        let prompt = serde_json::json!({ "prompt": "primary" });
        assert_eq!(
            extract_user_prompt(AgentKind::Codex, &prompt).as_deref(),
            Some("primary")
        );
        let user_msg = serde_json::json!({ "user_message": "fallback" });
        assert_eq!(
            extract_user_prompt(AgentKind::Codex, &user_msg).as_deref(),
            Some("fallback")
        );
    }

    #[test]
    fn extract_user_prompt_missing_field_returns_none() {
        let payload = serde_json::json!({ "other": "stuff" });
        assert!(extract_user_prompt(AgentKind::ClaudeCode, &payload).is_none());
    }

    #[test]
    fn extract_user_prompt_empty_or_whitespace_returns_none() {
        let blank = serde_json::json!({ "prompt": "   " });
        assert!(extract_user_prompt(AgentKind::ClaudeCode, &blank).is_none());
    }

    #[test]
    fn extract_user_prompt_shell_returns_none() {
        let payload = serde_json::json!({ "prompt": "ls" });
        assert!(extract_user_prompt(AgentKind::Shell, &payload).is_none());
    }

    #[test]
    fn truncate_prompt_short_passthrough() {
        assert_eq!(truncate_prompt("hello"), "hello");
    }

    #[test]
    fn truncate_prompt_caps_long_input_with_ellipsis() {
        let big = "a".repeat(MAX_PROMPT_BYTES + 100);
        let out = truncate_prompt(&big);
        assert!(out.ends_with('…'));
        assert!(out.len() <= MAX_PROMPT_BYTES + '…'.len_utf8());
    }

    #[test]
    fn truncate_prompt_respects_char_boundary() {
        // build a string whose byte length straddles MAX_PROMPT_BYTES on
        // a multi-byte char so a naive `&s[..MAX]` would panic.
        let mut s = "a".repeat(MAX_PROMPT_BYTES - 1);
        s.push('é'); // 2 bytes — boundary at MAX_PROMPT_BYTES + 1
        s.push_str(&"a".repeat(50));
        let out = truncate_prompt(&s);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn record_user_prompt_stores_and_returns_record() {
        let mut m = sm();
        let updated = m.record_user_prompt("refactor session".into(), 1_700_000_000_000);
        assert_eq!(updated.text, "refactor session");
        assert_eq!(updated.submitted_at_ms, 1_700_000_000_000);
        let stored = m.last_prompt().expect("last_prompt set");
        assert_eq!(stored.text, "refactor session");
    }

    #[test]
    fn extract_user_prompt_works_with_decode_payload_for_string_wrapper() {
        // Regression: the hook script `json_escape`s harness stdin into a
        // JSON-encoded *string*, so the wire payload arrives as
        // `Value::String("{...}")`. `decode_payload` unwraps the wrapper;
        // `extract_user_prompt` only sees fields after that decode runs.
        let raw = r#"{"session_id":"s-1","prompt":"refactor session.ts"}"#;
        let wire = serde_json::Value::String(raw.to_string());
        // Without decode: extraction fails because the value is a string.
        assert!(extract_user_prompt(AgentKind::ClaudeCode, &wire).is_none());
        // With decode: extraction succeeds.
        let decoded = crate::harness::decode_payload(&wire);
        assert_eq!(
            extract_user_prompt(AgentKind::ClaudeCode, decoded.as_ref()).as_deref(),
            Some("refactor session.ts")
        );
    }

    #[test]
    fn record_user_prompt_replaces_previous() {
        let mut m = sm();
        m.record_user_prompt("first".into(), 100);
        m.record_user_prompt("second".into(), 200);
        let stored = m.last_prompt().unwrap();
        assert_eq!(stored.text, "second");
        assert_eq!(stored.submitted_at_ms, 200);
    }
}
