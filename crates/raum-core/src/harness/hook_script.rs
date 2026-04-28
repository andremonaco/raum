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
//!
//! The two harnesses use different invocation contracts and we must
//! honour each one — sharing a single body wedges Codex (see below):
//!
//! - **Claude Code** pipes the hook payload on **stdin** and closes the
//!   fd, so the dispatcher reads it via `cat`.
//! - **Codex** passes the payload as the **last argv** (`argv[2]` after
//!   the event name) and inherits its own stdin into the child without
//!   closing it. Calling `cat` would block until Codex's 600 s default
//!   hook timeout fires, freezing every turn.

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
    match dispatcher {
        HookDispatcher::ClaudeCode => body_claude_code(),
        HookDispatcher::Codex => body_codex(),
    }
}

/// Pure-shell `awk` JSON-string escaper for the fallback transport path.
/// The normal path execs a single Python process and does JSON/socket work
/// there; if Python is unavailable, this keeps the shell fallback from
/// spawning Python again just to quote strings.
///
/// Handles `\`, `"`, `\t`, `\r`, and embedded `\n` (lines are joined
/// with `\\n` since awk strips trailing newlines per record). Other
/// control bytes (< 0x20) are extremely rare in raum-controlled hook
/// payloads and would only show up wrapped inside a JSON string from
/// Claude Code itself, where they'd already be escape-sequenced.
const AWK_JSON_ESCAPE: &str = r#"json_escape_stdin() {
  awk 'BEGIN{ORS=""; printf "\""}
       {if (NR > 1) printf "\\n";
        gsub(/\\/, "\\\\"); gsub(/"/, "\\\"");
        gsub(/\t/, "\\t"); gsub(/\r/, "\\r");
        printf "%s", $0}
       END{printf "\""}'
}
"#;

/// Python fast path for Claude Code hooks.
///
/// Kept before the shell fallback so the normal path does not fork `cat`,
/// `awk`, `socat`/`nc`, `head`, `od`, or `tr` for every hook event. This
/// matters when the OS is close to its per-user process limit: the harness
/// can launch the hook script successfully, then the script's first internal
/// fork fails with `Resource temporarily unavailable`.
const PYTHON_CLAUDE_FAST_PATH: &str = r#"PYTHON_BIN=""
if [ -x /usr/bin/python3 ]; then
  PYTHON_BIN=/usr/bin/python3
elif [ -x /opt/homebrew/bin/python3 ]; then
  PYTHON_BIN=/opt/homebrew/bin/python3
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN=python3
fi
if [ -n "$PYTHON_BIN" ]; then
  exec "$PYTHON_BIN" -c '
import json
import os
import socket
import sys
import uuid

sock_path = os.environ.get("RAUM_EVENT_SOCK") or ""
if not sock_path:
    raise SystemExit(0)

event = sys.argv[1] if len(sys.argv) > 1 else "unknown"
session_id = os.environ.get("RAUM_SESSION") or None
payload = sys.stdin.read()
timeout = float(os.environ.get("RAUM_HOOK_TIMEOUT_SECS", "55"))

def write_socket(envelope, wait_reply=False):
    line = json.dumps(envelope, separators=(",", ":")) + "\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        if wait_reply:
            sock.settimeout(timeout)
        sock.connect(sock_path)
        sock.sendall(line.encode("utf-8"))
        if not wait_reply:
            return ""
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
        return (buf.splitlines()[0] if buf else b"").decode("utf-8", errors="replace")

if event == "PermissionRequest":
    request_id = uuid.uuid4().hex
    envelope = {
        "harness": "claude-code",
        "event": event,
        "session_id": session_id,
        "request_id": request_id,
        "payload": payload,
    }
    try:
        decision = write_socket(envelope, wait_reply=True)
    except Exception:
        decision = ""

    if decision == "allow":
        out = {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}
    elif decision in ("allow-and-remember", "allow_and_remember"):
        out = {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}, "updatedPermissions": []}}
    elif decision == "deny":
        out = {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "deny", "message": "raum user denied"}}}
    else:
        out = {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "permissionDecision": "ask"}}
    sys.stdout.write(json.dumps(out, separators=(",", ":")) + "\n")
else:
    envelope = {
        "harness": "claude-code",
        "event": event,
        "session_id": session_id,
        "payload": payload,
    }
    try:
        write_socket(envelope)
    except Exception:
        pass
' "$@"
fi

"#;

/// Python fast path for Codex hook events. Codex passes the payload as argv,
/// not stdin, so this path must not read stdin.
const PYTHON_CODEX_FAST_PATH: &str = r#"PYTHON_BIN=""
if [ -x /usr/bin/python3 ]; then
  PYTHON_BIN=/usr/bin/python3
elif [ -x /opt/homebrew/bin/python3 ]; then
  PYTHON_BIN=/opt/homebrew/bin/python3
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN=python3
fi
if [ -n "$PYTHON_BIN" ]; then
  exec "$PYTHON_BIN" -c '
import json
import os
import socket
import sys

sock_path = os.environ.get("RAUM_EVENT_SOCK") or ""
if not sock_path:
    raise SystemExit(0)

event = sys.argv[1] if len(sys.argv) > 1 else "unknown"
payload_raw = sys.argv[2] if len(sys.argv) > 2 else "{}"
try:
    payload = json.loads(payload_raw)
except Exception:
    payload = {}
session_id = os.environ.get("RAUM_SESSION") or None
envelope = {
    "harness": "codex",
    "event": event,
    "session_id": session_id,
    "payload": payload,
}
line = json.dumps(envelope, separators=(",", ":")) + "\n"
timeout = float(os.environ.get("RAUM_HOOK_SEND_TIMEOUT_SECS", "1"))
try:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(sock_path)
        sock.sendall(line.encode("utf-8"))
        try:
            sock.shutdown(socket.SHUT_WR)
        except Exception:
            pass
except Exception:
    pass
' "$@"
fi

"#;

/// Claude Code dispatcher: stdin payload + blocking `PermissionRequest`.
///
/// Claude Code's hook contract pipes the JSON payload on stdin and
/// expects the script to print a JSON decision document to stdout for
/// `PermissionRequest`. The fire-and-forget branch covers every other
/// event (Notification, Stop, etc.).
fn body_claude_code() -> String {
    let timeout_secs = DEFAULT_PERMISSION_TIMEOUT_SECS;
    format!(
        r#"#!/usr/bin/env sh
{HEADER}set -eu
SOCK="${{RAUM_EVENT_SOCK:-}}"
if [ -z "$SOCK" ]; then exit 0; fi
{PYTHON_CLAUDE_FAST_PATH}
EVENT_NAME="${{1:-unknown}}"
SESSION_ID="${{RAUM_SESSION:-}}"
TIMEOUT_SECS="${{RAUM_HOOK_TIMEOUT_SECS:-{timeout_secs}}}"
PAYLOAD="$(cat || true)"

{AWK_JSON_ESCAPE}
QUOTED_PAYLOAD=$(printf '%s' "$PAYLOAD" | json_escape_stdin)

if [ -z "$SESSION_ID" ]; then
  SESSION_JSON="null"
else
  SESSION_JSON=$(printf '%s' "$SESSION_ID" | json_escape_stdin)
fi

send_fire_and_forget() {{
  # `$(...)` strips trailing newlines, so we build the body without one
  # and re-append it via `printf '%s\n'` below. The server framing is
  # newline-delimited, so we MUST terminate the line or the blocking
  # reader on the other side waits forever.
  JSON=$(printf '{{"harness":"claude-code","event":"%s","session_id":%s,"payload":%s}}' \
    "$EVENT_NAME" "$SESSION_JSON" "$QUOTED_PAYLOAD")
  if command -v socat >/dev/null 2>&1; then
    # `-u` = unidirectional (stdin → socket). socat exits on stdin EOF
    # instead of waiting for the peer to fully close, which on some
    # Linux builds it never detects promptly even when the peer has
    # dropped the connection.
    printf '%s\n' "$JSON" | socat -u - UNIX-CONNECT:"$SOCK" || true
  elif command -v nc >/dev/null 2>&1; then
    printf '%s\n' "$JSON" | nc -U "$SOCK" || true
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s\n' "$JSON" | python3 -c '
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
  REQ_ID=$(od -N8 -An -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' || date +%s%N)
  JSON=$(printf '{{"harness":"claude-code","event":"%s","session_id":%s,"request_id":"%s","payload":%s}}' \
    "$EVENT_NAME" "$SESSION_JSON" "$REQ_ID" "$QUOTED_PAYLOAD")
  DECISION=""
  if command -v socat >/dev/null 2>&1; then
    DECISION=$(printf '%s\n' "$JSON" | socat -T"$TIMEOUT_SECS" - UNIX-CONNECT:"$SOCK" 2>/dev/null | head -n1 || true)
  elif command -v nc >/dev/null 2>&1; then
    # OpenBSD `nc` has -w for read-timeout after EOF; we write then
    # read one line. The exact flag is platform-dependent; plain nc
    # without -N may hang here indefinitely, so a python3 fallback
    # is preferred when available.
    DECISION=$(printf '%s\n' "$JSON" | nc -U -w "$TIMEOUT_SECS" "$SOCK" 2>/dev/null | head -n1 || true)
  elif command -v python3 >/dev/null 2>&1; then
    DECISION=$(printf '%s\n' "$JSON" | python3 -c '
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

/// Codex dispatcher: argv payload, fire-and-forget only.
///
/// Codex invokes the script as `codex.sh <event> <json-payload>`. The
/// payload is already valid JSON, so we embed it verbatim — re-escaping
/// would corrupt nested strings. `PermissionRequest` is omitted because
/// Codex doesn't have an equivalent hook event; the JSON shapes returned
/// by `handle_permission_request` are Claude-Code-specific.
fn body_codex() -> String {
    format!(
        r#"#!/usr/bin/env sh
{HEADER}set -eu
SOCK="${{RAUM_EVENT_SOCK:-}}"
if [ -z "$SOCK" ]; then exit 0; fi
{PYTHON_CODEX_FAST_PATH}
EVENT_NAME="${{1:-unknown}}"
SESSION_ID="${{RAUM_SESSION:-}}"
# Codex hands the JSON payload as the LAST argv. The explicit if/else
# is intentional: the natural-looking `${{2-{{}}}}` fails because POSIX
# brace-matching closes the parameter expansion at the first inner
# brace, leaking a stray brace into the payload (same trap documented
# at the top of codex-notify.sh).
# Reading stdin via `cat` would block until Codex's 600 s hook timeout
# instead, since Codex inherits its own (open) stdin into the child.
if [ $# -ge 2 ]; then
  PAYLOAD="$2"
else
  PAYLOAD="{{}}"
fi

{AWK_JSON_ESCAPE}
if [ -z "$SESSION_ID" ]; then
  SESSION_JSON="null"
else
  SESSION_JSON=$(printf '%s' "$SESSION_ID" | json_escape_stdin)
fi

# Embed PAYLOAD verbatim — Codex guarantees it's already valid JSON.
# `$(...)` strips the trailing newline; the sending `printf '%s\n'`
# re-adds one so the newline-framed reader on the other end unblocks.
JSON=$(printf '{{"harness":"codex","event":"%s","session_id":%s,"payload":%s}}' \
  "$EVENT_NAME" "$SESSION_JSON" "$PAYLOAD")

if command -v socat >/dev/null 2>&1; then
  printf '%s\n' "$JSON" | socat -u - UNIX-CONNECT:"$SOCK" || true
elif command -v nc >/dev/null 2>&1; then
  printf '%s\n' "$JSON" | nc -U "$SOCK" || true
elif command -v python3 >/dev/null 2>&1; then
  printf '%s\n' "$JSON" | python3 -c '
import os, sys, socket
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(os.environ["RAUM_EVENT_SOCK"])
sock.sendall(sys.stdin.buffer.read())
sock.close()
' || true
fi
exit 0
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_body_reads_stdin() {
        let s = body(HookDispatcher::ClaudeCode);
        assert!(
            s.contains(r#"exec "$PYTHON_BIN" -c"#),
            "Claude dispatcher should use the single-process Python fast path when available"
        );
        assert!(
            s.contains(r#"PAYLOAD="$(cat || true)""#),
            "Claude fallback dispatcher must read stdin payload"
        );
        assert!(
            s.contains("handle_permission_request"),
            "Claude dispatcher must keep PermissionRequest branch"
        );
        assert!(
            s.contains(r#""harness":"claude-code""#),
            "Claude envelope must tag harness=claude-code"
        );
    }

    #[test]
    fn codex_body_reads_argv_not_stdin() {
        let s = body(HookDispatcher::Codex);
        assert!(
            s.contains(r#"exec "$PYTHON_BIN" -c"#),
            "Codex dispatcher should use the single-process Python fast path when available"
        );
        // The Codex script must NOT call `cat` to read the payload —
        // Codex inherits an open stdin and `cat` would hang for 600 s.
        assert!(
            !s.contains("cat || true"),
            "Codex dispatcher must not read stdin via cat (hang risk)"
        );
        // It must instead read positional arg 2 (with `{}` fallback).
        assert!(
            s.contains(r#"PAYLOAD="$2""#) && s.contains(r#"PAYLOAD="{}""#),
            "Codex dispatcher must read payload from argv[2] with explicit fallback"
        );
        // No PermissionRequest case — Codex has no equivalent event.
        assert!(
            !s.contains("handle_permission_request"),
            "Codex dispatcher should not include PermissionRequest branch"
        );
        assert!(
            s.contains(r#""harness":"codex""#),
            "Codex envelope must tag harness=codex"
        );
        // Payload must be embedded verbatim (no escaping pass).
        assert!(
            s.contains(r#""payload":%s"#) && s.contains(r#""$PAYLOAD""#),
            "Codex dispatcher must embed payload verbatim into envelope"
        );
        // No JSON-escaping pipeline applied to the payload.
        assert!(
            !s.contains(r#"$PAYLOAD" | json_escape_stdin"#),
            "Codex dispatcher must not re-escape an already-JSON payload"
        );
    }

    #[test]
    fn neither_body_spawns_python_for_routine_escape() {
        // python3 may still appear as an absolute-fallback transport,
        // but it must NOT be the routine JSON escaper — that was the
        // ~250 ms cold-start tax flagged in the perf review.
        for d in [HookDispatcher::ClaudeCode, HookDispatcher::Codex] {
            let s = body(d);
            assert!(
                !s.contains("python3 -c 'import json,sys"),
                "dispatcher {:?} still uses python3 for JSON escaping",
                d
            );
        }
    }
}
