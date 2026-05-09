//! Pure render helpers for Codex setup artifacts.
//!
//! Splits out the TOML/JSON managed-block builders and the `notify`
//! shell-script body so [`super::adapter`] can stay focused on the
//! plan-orchestration shape. All functions in here are pure — no IO, no
//! global state — so they are exercised both by `mod tests` and by the
//! integration tests in `crates/raum-core/tests/`.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::config_io::managed_json::{MARKER_BEGIN, MARKER_KEY};
use crate::harness::setup::SetupError;

use super::RAUM_CODEX_HOOK_EVENTS;

pub(super) fn render_codex_toml_managed_body(
    notify_script: &Path,
    enable_hooks: bool,
    trusted_paths: &[PathBuf],
    hooks_json_path: &Path,
    hook_script: &Path,
) -> String {
    // TOML arrays are top-level; the `[features]` and `[tui]` tables are
    // siblings. We emit them in a single managed block so the whole raum
    // configuration sits between the sentinels.
    //
    // `[tui] notifications / notification_method` is written **always**
    // (not gated on `enable_hooks`): approval prompts are the only
    // signal raum has for `Waiting` state on Codex, and that signal
    // only arrives as OSC 9 from the TUI. Older Codex builds that
    // don't recognise the key ignore it harmlessly; newer builds that
    // do need it would otherwise silently stay in `Working` through
    // every approval prompt.
    //
    // `[features] hooks` (renamed from `codex_hooks` in Codex 0.130 —
    // openai/codex#20684) and the `[hooks.state]` trust entries below
    // are both gated on `enable_hooks`: they only take effect on
    // versions that know about hooks at all, and the trust entries
    // pre-approve raum's own hooks.json so Codex's `/hooks` review
    // queue (openai/codex#20321) doesn't strand them in `Untrusted`.
    //
    // `[projects."<abs-path>"]` tables pre-declare every raum-registered
    // project + worktree as trusted. Codex keys its trust prompt on the
    // spawn cwd; without this raum users would re-accept per project and
    // per worktree.
    let path_json = serde_json::to_string(&notify_script.display().to_string())
        .unwrap_or_else(|_| "\"\"".into());
    let mut body = format!("notify = [{path_json}]\n");
    body.push_str("\n[tui]\nnotifications = true\nnotification_method = \"osc9\"\n");
    if enable_hooks {
        body.push_str("\n[features]\nhooks = true\n");
        // Pre-seed `[hooks.state."<key>"].trusted_hash` so each raum
        // hook lands as `Trusted` instead of `Untrusted` on first
        // launch. The key + hash format must mirror Codex's
        // `hook_key` / `version_for_toml` exactly — see the helpers
        // below.
        // Each event raum subscribes to is written as a single
        // matcher-group with a single handler in `hooks.json`, so the
        // positional indices Codex hashes into the state key are
        // always (0, 0).
        for event in RAUM_CODEX_HOOK_EVENTS {
            let key = codex_hook_state_key(hooks_json_path, event, 0, 0);
            let hash = codex_hook_trusted_hash(event, hook_script);
            let key_json = serde_json::to_string(&key).unwrap_or_else(|_| "\"\"".into());
            let hash_json = serde_json::to_string(&hash).unwrap_or_else(|_| "\"\"".into());
            let _ = write!(
                body,
                "\n[hooks.state.{key_json}]\ntrusted_hash = {hash_json}\n",
            );
        }
    }
    // De-duplicate while preserving insertion order (project root first,
    // worktrees in caller order) so the rendered body is stable across
    // runs — otherwise a HashSet would make the managed block churn.
    let mut seen: std::collections::HashSet<&Path> = std::collections::HashSet::new();
    for path in trusted_paths {
        if path.as_os_str().is_empty() || !seen.insert(path.as_path()) {
            continue;
        }
        let key =
            serde_json::to_string(&path.display().to_string()).unwrap_or_else(|_| "\"\"".into());
        let _ = write!(body, "\n[projects.{key}]\ntrust_level = \"trusted\"\n");
    }
    let rendered = crate::config_io::managed_toml::render(None, body.trim_end());
    // Strip the begin/end sentinel frames — the `SetupAction::WriteToml`
    // executor currently does an atomic full-file write, not a managed
    // splice, so we have to frame the whole file here. Rather than add a
    // new "apply_managed_block" executor variant, the content we pass
    // to `WriteToml` is the *entire file* with the managed block in it.
    // An existing user file is not preserved through `WriteToml`.
    // Callers that need preservation call `apply_managed_toml_block`
    // directly from an integration test or runtime shim.
    rendered
}

pub(super) fn render_codex_hooks_json(hook_script: &Path) -> Result<String, SetupError> {
    // Build the Codex-shaped top-level object: `{ "hooks": {...} }`.
    let mut hooks_obj = serde_json::Map::new();
    for event in RAUM_CODEX_HOOK_EVENTS {
        hooks_obj.insert(
            (*event).to_string(),
            Value::Array(vec![codex_hook_entry(event, hook_script)]),
        );
    }
    let root = json!({
        "hooks": Value::Object(hooks_obj),
    });
    serde_json::to_string_pretty(&root).map_err(|e| SetupError::Serialize(e.to_string()))
}

pub(super) fn codex_hook_entry(event: &str, hook_script: &Path) -> Value {
    // Codex timeout default is 600 s per upstream docs; leave
    // unspecified so we track that default automatically.
    json!({
        MARKER_KEY: MARKER_BEGIN,
        "_raum_event": event,
        "matcher": ".*",
        "hooks": [
            {
                "type": "command",
                "command": format!("{} {}", hook_script.display(), event),
                "statusMessage": format!("raum: forwarding {event}"),
            }
        ],
    })
}

/// Snake-case label for an event, mirroring upstream
/// `codex-rs/hooks/src/lib.rs::hook_event_key_label`. raum subscribes
/// to two events today; if `RAUM_CODEX_HOOK_EVENTS` ever grows, extend
/// this map at the same time. Unknown events fall through to the input
/// string so a missing arm shows up as a hash/key mismatch in tests
/// rather than a silent panic at startup.
fn codex_hook_event_label(event: &str) -> &str {
    match event {
        "PreToolUse" => "pre_tool_use",
        "PermissionRequest" => "permission_request",
        "PostToolUse" => "post_tool_use",
        "PreCompact" => "pre_compact",
        "PostCompact" => "post_compact",
        "SessionStart" => "session_start",
        "UserPromptSubmit" => "user_prompt_submit",
        "Stop" => "stop",
        other => other,
    }
}

/// Build the `[hooks.state."<key>"]` table key Codex uses to look up
/// per-hook trust state. Mirrors `hook_key` in
/// `codex-rs/hooks/src/lib.rs`:
///   `"{source_path}:{event_label}:{group_index}:{handler_index}"`.
pub(super) fn codex_hook_state_key(
    hooks_json_path: &Path,
    event: &str,
    group_index: usize,
    handler_index: usize,
) -> String {
    format!(
        "{}:{}:{group_index}:{handler_index}",
        hooks_json_path.display(),
        codex_hook_event_label(event),
    )
}

/// Compute the `trusted_hash` Codex expects for a raum hook. Mirrors
/// `command_hook_hash` + `version_for_toml` in
/// `codex-rs/hooks/src/engine/discovery.rs` and
/// `codex-rs/config/src/fingerprint.rs`: SHA-256 over a canonical-JSON
/// serialisation (recursively sorted object keys) of the normalised
/// `{event_name, matcher, hooks: [Command]}` identity, hex-lowercase,
/// prefixed `sha256:`. The handler matches what
/// [`render_codex_hooks_json`] writes after Codex's discovery
/// normalisation step (timeout `None` → 600, `async` defaulted to
/// `false`).
pub(super) fn codex_hook_trusted_hash(event: &str, hook_script: &Path) -> String {
    let identity = json!({
        "event_name": codex_hook_event_label(event),
        "matcher": ".*",
        "hooks": [
            {
                "type": "command",
                "command": format!("{} {}", hook_script.display(), event),
                "timeout": 600u64,
                "async": false,
                "statusMessage": format!("raum: forwarding {event}"),
            }
        ],
    });
    let canonical = canonicalize_json(identity);
    let bytes = serde_json::to_vec(&canonical).unwrap_or_default();
    let digest = Sha256::digest(&bytes);
    let mut hex = String::with_capacity(7 + digest.len() * 2);
    hex.push_str("sha256:");
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// Recursively sort object keys so two structurally-equivalent JSON
/// values produce identical byte-strings. Matches the `canonical_json`
/// helper inside `codex-rs/config/src/fingerprint.rs`.
fn canonicalize_json(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sorted: std::collections::BTreeMap<String, Value> =
                std::collections::BTreeMap::new();
            for (k, v) in map {
                sorted.insert(k, canonicalize_json(v));
            }
            let mut out = serde_json::Map::with_capacity(sorted.len());
            for (k, v) in sorted {
                out.insert(k, v);
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(canonicalize_json).collect()),
        other => other,
    }
}

/// Body of the `codex-notify.sh` script.
///
/// Codex invokes the notify command as
/// `argv[0]=<path> argv[1]=<json-payload>` (the JSON is the *last argv*,
/// not piped on stdin — confirmed against
/// `openai/codex:codex-rs/hooks/src/legacy_notify.rs`, which appends the
/// serialised payload with `command.arg(notify_payload)`). The script
/// wraps that payload in the raum event-socket envelope and forwards it
/// using the `socat` / `nc` / `python3` fallback chain already in use by
/// `raum-hooks/src/scripts.rs`.
pub fn codex_notify_script_body(_event_socket: &Path) -> String {
    // `$RAUM_EVENT_SOCK` is exported by raum at startup (see
    // `raum-hooks::set_event_sock_env`). The script reads that env var
    // rather than baking the path in, so a moved raum install doesn't
    // strand the script.
    String::from(
        r#"#!/usr/bin/env sh
# raum-managed — do not edit; regenerated on launch
# codex-notify.sh: Codex invokes this with the JSON payload as argv[1].
set -eu
SOCK="${RAUM_EVENT_SOCK:-}"
if [ -z "$SOCK" ]; then exit 0; fi
PYTHON_BIN=""
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

payload_raw = sys.argv[1] if len(sys.argv) > 1 else "{}"
try:
    payload = json.loads(payload_raw)
except Exception:
    payload = {}
session_id = os.environ.get("RAUM_SESSION") or None
envelope = {
    "harness": "codex",
    "event": "Notification",
    "source": "notify",
    "reliability": "event-driven",
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
SESSION_ID="${RAUM_SESSION:-}"
# Codex invokes us with the serialised JSON as argv[1]. Use `${1-}` (no
# colon) so an empty string is still accepted; the previous form
# `${1:-{}}` tripped over POSIX brace-matching — `}` inside the default
# word terminates the expansion — and leaked a stray `}` into the
# payload. Fall back to `{}` (valid JSON) when argv[1] is unset entirely.
if [ $# -ge 1 ]; then
  PAYLOAD="$1"
else
  PAYLOAD="{}"
fi

json_escape_stdin() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
  else
    printf '""'
  fi
}

if [ -z "$SESSION_ID" ]; then
  SESSION_JSON="null"
else
  SESSION_JSON=$(printf '%s' "$SESSION_ID" | json_escape_stdin)
fi

# The payload Codex hands us is already JSON; embed it verbatim.
# Build without the trailing `\n` — `$(...)` strips it off — and
# re-append at the sending `printf` below. The server framing is
# newline-delimited; forgetting the newline blocks the reader forever.
ENVELOPE=$(printf '{"harness":"codex","event":"Notification","source":"notify","reliability":"event-driven","session_id":%s,"payload":%s}' \
  "$SESSION_JSON" "$PAYLOAD")

if command -v socat >/dev/null 2>&1; then
  # `-u` = unidirectional (stdin → socket); exits on stdin EOF rather
  # than waiting on the peer, which some Linux socat builds are slow
  # to notice even after the server closes the socket.
  printf '%s\n' "$ENVELOPE" | socat -u - UNIX-CONNECT:"$SOCK" || true
elif command -v nc >/dev/null 2>&1; then
  printf '%s\n' "$ENVELOPE" | nc -U "$SOCK" || true
elif command -v python3 >/dev/null 2>&1; then
  printf '%s\n' "$ENVELOPE" | python3 -c '
import os, sys, socket
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(os.environ["RAUM_EVENT_SOCK"])
sock.sendall(sys.stdin.buffer.read())
sock.close()
' || true
fi
"#,
    )
}
