//! Per-invocation progress events for long-running worktree / project commands
//! (`worktree_create`, `worktree_remove`, `project_remove`).
//!
//! The frontend opens a `Channel<ProgressEvent>` per call and the backend
//! pushes one event per discrete step transition. The webview renders a
//! checklist UI driven entirely off this stream — pending → spinner →
//! checkmark / red-X — so the user can see what the app is doing while
//! file copies, git subprocesses, and harness hooks run on the blocking pool.
//!
//! See `docs/architecture` if you need a refresher; the canonical streaming
//! pattern is `terminal_spawn` (`commands/terminal.rs`).
//!
//! Wire shape (camelCase JSON, internally tagged on `kind`):
//!
//! ```text
//! { "kind": "step",    "id": "git-add",  "label": "Creating git worktree", "status": "running" }
//! { "kind": "counter", "id": "hydrate",  "current": 47, "total": 200 }
//! { "kind": "done" }
//! { "kind": "failed",  "message": "git worktree add: fatal: ..." }
//! ```

use serde::Serialize;
use tauri::ipc::Channel;

/// Lifecycle of a single named step inside a streamed operation.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepStatus {
    /// Initial state for steps the backend hasn't reached yet. The Rust side
    /// never emits `Pending` — the FE seeds it from the step template — but
    /// it's part of the wire enum so the FE can use the same type.
    #[allow(dead_code)]
    Pending,
    Running,
    Completed,
    Skipped,
    Failed,
}

/// Discriminated message pushed over the per-invocation `Channel<ProgressEvent>`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ProgressEvent {
    /// Status transition for a single named step.
    Step {
        id: String,
        label: String,
        status: StepStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// Sub-step counter (used by the hydration step to report
    /// `47 / 200 files copied` while the step is still `Running`).
    Counter {
        id: String,
        current: u64,
        total: u64,
    },
    /// Operation completed successfully. Always last on the happy path.
    Done,
    /// Operation aborted with `message`. Always last on the failure path.
    Failed { message: String },
}

#[inline]
pub fn emit_step(channel: &Channel<ProgressEvent>, id: &str, label: &str, status: StepStatus) {
    let _ = channel.send(ProgressEvent::Step {
        id: id.to_string(),
        label: label.to_string(),
        status,
        detail: None,
    });
}

#[inline]
pub fn emit_step_detail(
    channel: &Channel<ProgressEvent>,
    id: &str,
    label: &str,
    status: StepStatus,
    detail: impl Into<String>,
) {
    let _ = channel.send(ProgressEvent::Step {
        id: id.to_string(),
        label: label.to_string(),
        status,
        detail: Some(detail.into()),
    });
}

#[inline]
pub fn emit_counter(channel: &Channel<ProgressEvent>, id: &str, current: u64, total: u64) {
    let _ = channel.send(ProgressEvent::Counter {
        id: id.to_string(),
        current,
        total,
    });
}

#[inline]
pub fn emit_done(channel: &Channel<ProgressEvent>) {
    let _ = channel.send(ProgressEvent::Done);
}

#[inline]
pub fn emit_failed(channel: &Channel<ProgressEvent>, message: impl Into<String>) {
    let _ = channel.send(ProgressEvent::Failed {
        message: message.into(),
    });
}
