//! Hook-script writer.
//!
//! Phase 2 extends the Claude Code script with:
//!
//! * `$RAUM_SESSION` session-id embedding (so the event socket can route
//!   to a specific session rather than broadcasting by harness).
//! * A `python3` fallback after the existing `socat` → `nc` chain, for
//!   hosts where neither is available.
//! * A blocking `PermissionRequest` handler: the script opens the socket,
//!   writes the request JSON (now including a generated `request_id`),
//!   then reads one decision line from the same connection and prints
//!   the matching Claude-Code-compatible JSON to stdout before exiting 0.
//!   On timeout (default 55 s — leaving 5 s headroom below Claude's 60 s
//!   hook timeout) the script falls back to `permissionDecision: "ask"`
//!   so Claude's own TUI prompt fires.
//!
//! Other events remain fire-and-forget as before.

use std::path::Path;

use raum_core::agent::AgentKind;
use thiserror::Error;
use tracing::info;

#[derive(Debug, Error)]
pub enum HookScriptError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("hooks dir not writable: {0}")]
    NotWritable(std::path::PathBuf),
}

const HEADER: &str = "# raum-managed — do not edit; regenerated on launch\n";

/// Default timeout the `PermissionRequest` script waits before falling
/// back to `"ask"`. 55 s gives Claude Code (60 s default hook timeout)
/// 5 s of headroom for stdout capture + process teardown.
pub const DEFAULT_PERMISSION_TIMEOUT_SECS: u32 = 55;

pub fn write_hook_scripts(hooks_dir: &Path) -> Result<Vec<std::path::PathBuf>, HookScriptError> {
    std::fs::create_dir_all(hooks_dir)?;
    if !is_writable(hooks_dir) {
        return Err(HookScriptError::NotWritable(hooks_dir.to_path_buf()));
    }
    let kinds = [AgentKind::ClaudeCode, AgentKind::Codex, AgentKind::OpenCode];
    let mut written = Vec::new();
    for kind in kinds {
        let path = hooks_dir.join(format!("{}.sh", harness_filename(kind)));
        let body = render_script(kind);
        std::fs::write(&path, body)?;
        set_0700(&path)?;
        info!(?path, "wrote hook script");
        written.push(path);
    }
    Ok(written)
}

fn render_script(kind: AgentKind) -> String {
    let harness = harness_filename(kind);
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
    printf '%s' "$JSON" | socat - UNIX-CONNECT:"$SOCK" || true
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

fn harness_filename(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::ClaudeCode => "claude-code",
        AgentKind::Codex => "codex",
        AgentKind::OpenCode => "opencode",
        AgentKind::Shell => "shell",
    }
}

#[cfg(unix)]
fn set_0700(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o700);
    std::fs::set_permissions(path, perms)
}

#[cfg(not(unix))]
fn set_0700(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(".raum-write-probe");
    let res = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(&probe);
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn writes_three_scripts() {
        let dir = tempdir().unwrap();
        let written = write_hook_scripts(dir.path()).unwrap();
        assert_eq!(written.len(), 3);
        let expected_names = ["claude-code.sh", "codex.sh", "opencode.sh"];
        for (p, name) in written.iter().zip(expected_names.iter()) {
            assert!(p.exists());
            assert_eq!(p.file_name().unwrap().to_str().unwrap(), *name);
            let body = std::fs::read_to_string(p).unwrap();
            assert!(body.starts_with("#!/usr/bin/env sh"));
            assert!(body.contains("raum-managed"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn scripts_are_mode_0700() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let written = write_hook_scripts(dir.path()).unwrap();
        for p in &written {
            let mode = std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "expected 0700 on {p:?}, got {mode:o}");
        }
    }

    #[test]
    fn script_body_references_raum_event_sock() {
        let dir = tempdir().unwrap();
        let written = write_hook_scripts(dir.path()).unwrap();
        for p in &written {
            let body = std::fs::read_to_string(p).unwrap();
            assert!(
                body.contains("$RAUM_EVENT_SOCK") || body.contains("${RAUM_EVENT_SOCK"),
                "script {p:?} must reference $RAUM_EVENT_SOCK, body was:\n{body}"
            );
        }
    }

    #[test]
    fn script_body_embeds_session_id_placeholder() {
        let dir = tempdir().unwrap();
        let written = write_hook_scripts(dir.path()).unwrap();
        for p in &written {
            let body = std::fs::read_to_string(p).unwrap();
            assert!(
                body.contains("RAUM_SESSION"),
                "script {p:?} must reference $RAUM_SESSION for session-scoping",
            );
        }
    }

    #[test]
    fn script_body_has_permission_request_handler_and_python3_fallback() {
        let dir = tempdir().unwrap();
        let written = write_hook_scripts(dir.path()).unwrap();
        for p in &written {
            let body = std::fs::read_to_string(p).unwrap();
            assert!(
                body.contains("handle_permission_request"),
                "script {p:?} must define handle_permission_request",
            );
            assert!(
                body.contains("python3 -c"),
                "script {p:?} must include a python3 fallback",
            );
            assert!(
                body.contains("permissionDecision"),
                "script {p:?} must emit Claude-Code compatible permissionDecision JSON",
            );
            assert!(
                body.contains("\"behavior\":\"allow\""),
                "script {p:?} must emit allow decision JSON",
            );
            assert!(
                body.contains("\"behavior\":\"deny\""),
                "script {p:?} must emit deny decision JSON",
            );
        }
    }

    #[test]
    fn rewriting_is_byte_identical() {
        let dir = tempdir().unwrap();
        let first = write_hook_scripts(dir.path()).unwrap();
        let first_bytes: Vec<Vec<u8>> = first.iter().map(|p| std::fs::read(p).unwrap()).collect();

        let second = write_hook_scripts(dir.path()).unwrap();
        assert_eq!(first, second, "write order must be stable across runs");
        let second_bytes: Vec<Vec<u8>> = second.iter().map(|p| std::fs::read(p).unwrap()).collect();

        assert_eq!(
            first_bytes, second_bytes,
            "re-running write_hook_scripts must produce byte-identical files"
        );
    }
}
