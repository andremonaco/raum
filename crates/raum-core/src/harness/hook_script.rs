//! Per-harness hook-dispatcher shell-script body generator.
//!
//! Lives in `raum-core` (not `raum-hooks`) because the adapters that
//! emit `SetupAction::WriteShellScript` actions live here, and the
//! `raum-hooks` crate already depends on `raum-core` — so the body has
//! to flow in this direction to avoid a crate cycle.
//!
//! The script body is pure: it reads `$RAUM_EVENT_SOCK`,
//! `$RAUM_SESSION`, and `$RAUM_HOOK_TIMEOUT_SECS` at runtime, so no
//! socket path is baked in at generation time.

use crate::agent::AgentKind;

const HEADER: &str = "# raum-managed — do not edit; regenerated on launch\n";

/// Default timeout the `PermissionRequest` script waits before falling
/// back to `"ask"`. 55 s gives Claude Code (60 s default hook timeout)
/// 5 s of headroom for stdout capture + process teardown.
pub const DEFAULT_PERMISSION_TIMEOUT_SECS: u32 = 55;

/// Harnesses that use a raum-written hook dispatcher script. OpenCode
/// is absent on purpose: notifications flow over SSE, not shell hooks
/// (Phase 4), so no `opencode.sh` is written or referenced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookDispatcher {
    ClaudeCode,
    Codex,
}

impl HookDispatcher {
    /// Filename stem used both as the `<stem>.sh` file name and as the
    /// `harness` tag in the JSON envelope forwarded to the event socket.
    #[must_use]
    pub fn harness_tag(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
        }
    }
}

impl TryFrom<AgentKind> for HookDispatcher {
    type Error = AgentKind;

    fn try_from(value: AgentKind) -> Result<Self, Self::Error> {
        match value {
            AgentKind::ClaudeCode => Ok(Self::ClaudeCode),
            AgentKind::Codex => Ok(Self::Codex),
            other => Err(other),
        }
    }
}

/// Render the per-harness hook-dispatcher shell script body.
///
/// Used by adapter `plan()` methods to emit a
/// [`crate::harness::setup::SetupAction::WriteShellScript`] whose
/// `content` is this body.
#[must_use]
pub fn body(dispatcher: HookDispatcher) -> String {
    let harness = dispatcher.harness_tag();
    let timeout_secs = DEFAULT_PERMISSION_TIMEOUT_SECS;
    format!(
        r#"#!/usr/bin/env sh
{HEADER}set -eu
SOCK="${{RAUM_EVENT_SOCK:-}}"
if [ -z "$SOCK" ]; then exit 0; fi
EVENT_NAME="${{1:-unknown}}"
SESSION_ID="${{RAUM_SESSION:-}}"
TIMEOUT_SECS="${{RAUM_HOOK_TIMEOUT_SECS:-{timeout_secs}}}"
PAYLOAD="$(cat || true)"

# json_escape stdin → stdout-quoted JSON string. Uses python3 when
# available; falls back to a best-effort empty "" for hosts that lack it.
json_escape() {{
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
  else
    printf '""'
  fi
}}

QUOTED_PAYLOAD=$(printf '%s' "$PAYLOAD" | json_escape)

# Build {{"harness":"…","event":"…","session_id":…,"request_id":…?,"payload":…}}.
# request_id is injected only for PermissionRequest events; other events
# omit the field to keep the fire-and-forget wire shape unchanged.
if [ -z "$SESSION_ID" ]; then
  SESSION_JSON="null"
else
  SESSION_JSON=$(printf '%s' "$SESSION_ID" | json_escape)
fi

send_fire_and_forget() {{
  JSON=$(printf '{{"harness":"%s","event":"%s","session_id":%s,"payload":%s}}\n' \
    "{harness}" "$EVENT_NAME" "$SESSION_JSON" "$QUOTED_PAYLOAD")
  if command -v socat >/dev/null 2>&1; then
    # `-u` = unidirectional (stdin → socket). socat exits on stdin EOF
    # instead of waiting for the peer to fully close, which on some
    # Linux builds it never detects promptly even when the peer has
    # dropped the connection.
    printf '%s' "$JSON" | socat -u - UNIX-CONNECT:"$SOCK" || true
  elif command -v nc >/dev/null 2>&1; then
    printf '%s' "$JSON" | nc -U "$SOCK" || true
  elif command -v python3 >/dev/null 2>&1; then
    # python3 fallback — hosts without socat/nc still get delivery.
    printf '%s' "$JSON" | python3 -c '
import os, sys, socket
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(os.environ["RAUM_EVENT_SOCK"])
data = sys.stdin.buffer.read()
sock.sendall(data)
sock.close()
' || true
  fi
}}

# Blocking PermissionRequest: emit request + read one decision line back
# + print the corresponding Claude-Code-compatible JSON to stdout. On
# timeout or transport failure, fall through to permissionDecision:"ask"
# so Claude Code shows its native TUI prompt (graceful degradation).
handle_permission_request() {{
  # Generate a short request id. `od -N8 -An -tx1` is POSIX-portable
  # (works on BusyBox); we collapse the spaces into a single hex string.
  REQ_ID=$(od -N8 -An -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' || date +%s%N)
  JSON=$(printf '{{"harness":"%s","event":"%s","session_id":%s,"request_id":"%s","payload":%s}}\n' \
    "{harness}" "$EVENT_NAME" "$SESSION_JSON" "$REQ_ID" "$QUOTED_PAYLOAD")
  DECISION=""
  if command -v socat >/dev/null 2>&1; then
    DECISION=$(printf '%s' "$JSON" | socat -T"$TIMEOUT_SECS" - UNIX-CONNECT:"$SOCK" 2>/dev/null | head -n1 || true)
  elif command -v nc >/dev/null 2>&1; then
    # OpenBSD `nc` has -w for read-timeout after EOF; we write then
    # read one line. The exact flag is platform-dependent; plain nc
    # without -N may hang here indefinitely, so a python3 fallback
    # is preferred when available.
    DECISION=$(printf '%s' "$JSON" | nc -U -w "$TIMEOUT_SECS" "$SOCK" 2>/dev/null | head -n1 || true)
  elif command -v python3 >/dev/null 2>&1; then
    DECISION=$(printf '%s' "$JSON" | python3 -c '
import os, socket, sys
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.settimeout(float(os.environ.get("RAUM_HOOK_TIMEOUT_SECS", "{timeout_secs}")))
sock.connect(os.environ["RAUM_EVENT_SOCK"])
data = sys.stdin.buffer.read()
sock.sendall(data)
try:
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
    line = buf.splitlines()[0] if buf else b""
    sys.stdout.write(line.decode("utf-8", errors="replace"))
except Exception:
    pass
finally:
    try: sock.close()
    except Exception: pass
' 2>/dev/null || true)
  fi
  case "$DECISION" in
    allow)
      printf '{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{{"behavior":"allow"}}}}}}\n'
      ;;
    allow-and-remember|allow_and_remember)
      printf '{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{{"behavior":"allow"}},"updatedPermissions":[]}}}}\n'
      ;;
    deny)
      printf '{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{{"behavior":"deny","message":"raum user denied"}}}}}}\n'
      ;;
    ask|"")
      # Timeout / no-decision fallback: tell Claude to use its native
      # TUI prompt. Emitting an empty JSON object is also acceptable
      # per the hooks spec, but `permissionDecision:"ask"` is explicit.
      printf '{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","permissionDecision":"ask"}}}}\n'
      ;;
    *)
      printf '{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","permissionDecision":"ask"}}}}\n'
      ;;
  esac
  exit 0
}}

case "$EVENT_NAME" in
  PermissionRequest)
    handle_permission_request
    ;;
  *)
    send_fire_and_forget
    exit 0
    ;;
esac
"#
    )
}
