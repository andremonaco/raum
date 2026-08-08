//! Pure render helpers for Codex setup artifacts.
//!
//! Splits out the TOML/JSON merge builders and the `notify`
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

/// Merge raum's keys into an existing Codex `config.toml`, preserving
/// every byte the user wrote — formatting, comments, and unrelated keys
/// survive untouched (`toml_edit` is format-preserving). Returns the
/// full new file contents for `SetupAction::WriteToml`.
///
/// A sentinel-block splice cannot work here: raum owns the top-level
/// `notify` key, and TOML scopes bare keys to the nearest preceding
/// `[table]` header — a block appended after user content would silently
/// re-scope `notify` into the user's last table. Targeted key writes
/// have no placement problem, so raum overlays exactly the keys it owns:
///
/// * `notify = ["<codex-notify.sh>"]` — turn-complete forwarder.
/// * `[tui] notifications / notification_method = "osc9"` — approval
///   prompts are the only `Waiting` signal raum has on Codex, and they
///   arrive solely as OSC 9 from the TUI.
/// * `[tui] notification_condition = "always"` — Codex defaults to
///   `unfocused` and boots with `terminal_focused = true`
///   (codex-rs/tui/src/tui.rs); inside tmux focus events rarely arrive,
///   so every OSC 9 would be suppressed. raum's notification center
///   applies its own focus gating downstream.
/// * `[features] hooks = true` (renamed from `codex_hooks` in Codex
///   0.130 — openai/codex#20684) and `[hooks.state."<key>"].trusted_hash`
///   pre-approvals (openai/codex#20321), both gated on `enable_hooks`.
/// * `[projects."<abs-path>"] trust_level = "trusted"` for the project
///   root and every raum-known worktree, so Codex never re-prompts for
///   a registered path. User-added `[projects]` entries are untouched.
///
/// A legacy `# <raum-managed>` sentinel block from earlier raum versions
/// is stripped first — every key it carried is re-asserted as a targeted
/// write, so the block migrates away on first contact.
///
/// Errors instead of clobbering when the existing file is not valid
/// TOML, or when a key raum needs as a table exists as something else.
// ponytail: stale [hooks.state] / [projects] entries from renamed or
// de-registered projects linger (harmless — they reference paths Codex
// no longer discovers); add prefix-scoped cleanup if they ever bother.
pub(super) fn merge_codex_config_toml(
    existing: Option<&str>,
    notify_script: &Path,
    enable_hooks: bool,
    trusted_paths: &[PathBuf],
    hooks_json_path: &Path,
    hook_script: &Path,
) -> Result<String, SetupError> {
    use toml_edit::{DocumentMut, value};

    let base = existing.map(|raw| {
        crate::config_io::managed_toml::remove_managed_block(raw).unwrap_or_else(|| raw.to_string())
    });
    let mut doc: DocumentMut = base.as_deref().unwrap_or("").parse().map_err(|e| {
        SetupError::Planner(format!(
            "existing Codex config.toml is not valid TOML ({e}); refusing to modify it"
        ))
    })?;

    doc["notify"] = value(toml_edit::Array::from_iter([notify_script
        .display()
        .to_string()]));
    let tui = table_at(&mut doc, &["tui"])?;
    tui["notifications"] = value(true);
    tui["notification_method"] = value("osc9");
    tui["notification_condition"] = value("always");
    if enable_hooks {
        table_at(&mut doc, &["features"])?["hooks"] = value(true);
        // Pre-seed `[hooks.state."<key>"].trusted_hash` so each raum
        // hook lands as `Trusted` instead of `Untrusted` on first
        // launch. raum's entry is always the first matcher-group /
        // first handler in hooks.json (see `merge_codex_hooks_json`),
        // so the positional indices in the state key are (0, 0).
        for event in RAUM_CODEX_HOOK_EVENTS {
            let key = codex_hook_state_key(hooks_json_path, event, 0, 0);
            let hash = codex_hook_trusted_hash(event, hook_script);
            table_at(&mut doc, &["hooks", "state", &key])?.insert("trusted_hash", value(hash));
        }
    }
    // De-duplicate while preserving insertion order (project root first,
    // worktrees in caller order) so re-runs stay byte-stable.
    let mut seen: std::collections::HashSet<&Path> = std::collections::HashSet::new();
    for path in trusted_paths {
        if path.as_os_str().is_empty() || !seen.insert(path.as_path()) {
            continue;
        }
        table_at(&mut doc, &["projects", &path.display().to_string()])?
            .insert("trust_level", value("trusted"));
    }
    Ok(doc.to_string())
}

/// Walk (creating as needed) nested tables at `path`. Newly created
/// intermediates are marked implicit so `[hooks]` headers without direct
/// keys are not emitted. Errors when an existing key is not a table —
/// the graceful alternative to `toml_edit`'s panicking index operators.
fn table_at<'a>(
    doc: &'a mut toml_edit::DocumentMut,
    path: &[&str],
) -> Result<&'a mut toml_edit::Table, SetupError> {
    let mut tbl = doc.as_table_mut();
    for seg in path {
        let item = tbl.entry(seg).or_insert_with(|| {
            let mut t = toml_edit::Table::new();
            t.set_implicit(true);
            toml_edit::Item::Table(t)
        });
        tbl = item.as_table_mut().ok_or_else(|| {
            SetupError::Planner(format!(
                "Codex config.toml key `{seg}` exists but is not a table; refusing to overwrite"
            ))
        })?;
    }
    Ok(tbl)
}

/// Merge raum's hook entries into an existing Codex `hooks.json`,
/// preserving user-authored entries. Returns the full new file contents
/// for `SetupAction::WriteJson`.
///
/// raum's entry is **inserted at index 0** of each event array, not
/// appended: Codex keys per-hook trust state positionally
/// (`<path>:<event>:<group_index>:<handler_index>`), and the
/// `trusted_hash` entries raum pre-seeds in config.toml assume (0, 0).
/// Appending after user entries would make raum's indices depend on how
/// many hooks the user has — and shift whenever that changes.
///
/// Errors instead of clobbering when the existing file is not valid
/// JSON.
pub(super) fn merge_codex_hooks_json(
    existing: Option<&str>,
    hook_script: &Path,
) -> Result<String, SetupError> {
    let mut root: Value = match existing {
        Some(raw) => serde_json::from_str(raw).map_err(|e| {
            SetupError::Planner(format!(
                "existing Codex hooks.json is not valid JSON ({e}); refusing to modify it"
            ))
        })?,
        None => json!({}),
    };
    if !root.is_object() {
        root = json!({});
    }
    let hooks = root
        .as_object_mut()
        .expect("root is object")
        .entry("hooks")
        .or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks_obj = hooks.as_object_mut().expect("hooks is object");
    for event in RAUM_CODEX_HOOK_EVENTS {
        let arr_entry = hooks_obj
            .entry((*event).to_string())
            .or_insert_with(|| json!([]));
        if !arr_entry.is_array() {
            *arr_entry = json!([]);
        }
        let arr = arr_entry.as_array_mut().expect("hooks.<event> is array");
        arr.retain(|v| !crate::config_io::managed_json::is_raum_managed(v));
        arr.insert(0, codex_hook_entry(event, hook_script));
    }
    serde_json::to_string_pretty(&root).map_err(|e| SetupError::Serialize(e.to_string()))
}

/// Matcher raum writes on every managed hook entry. Shared with
/// [`codex_hook_trusted_hash`] so the written entry and the pre-seeded
/// hash can never drift apart for the events that keep their matcher.
const CODEX_HOOK_MATCHER: &str = ".*";

pub(super) fn codex_hook_entry(event: &str, hook_script: &Path) -> Value {
    // Codex timeout default is 600 s per upstream docs; leave
    // unspecified so we track that default automatically. The
    // dispatcher self-limits the blocking `PermissionRequest` wait via
    // `RAUM_HOOK_TIMEOUT_SECS`, so it never rides the 600 s ceiling.
    json!({
        MARKER_KEY: MARKER_BEGIN,
        "_raum_event": event,
        "matcher": CODEX_HOOK_MATCHER,
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
/// `codex-rs/hooks/src/lib.rs::hook_event_key_label`. If
/// `RAUM_CODEX_HOOK_EVENTS` ever grows, extend this map at the same
/// time. Unknown events fall through to the input
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

/// Whether Codex keeps the entry's `matcher` when it normalises a hook
/// for hashing. Mirrors upstream `HOOK_EVENT_NAMES_WITH_MATCHERS` /
/// `matcher_pattern_for_event`: every event carries a matcher except
/// `UserPromptSubmit` and `Stop`, which are forced to `None`. Listing
/// the positives explicitly keeps a future addition to
/// [`RAUM_CODEX_HOOK_EVENTS`] from silently inheriting the wrong side.
fn codex_event_has_matcher(event: &str) -> bool {
    matches!(
        event,
        "PermissionRequest" | "PreToolUse" | "PostToolUse" | "PreCompact" | "PostCompact"
    )
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
/// `{event_name, hooks: [Command]}` identity, hex-lowercase, prefixed
/// `sha256:`. The handler matches what [`render_codex_hooks_json`]
/// writes after Codex's discovery normalisation step (timeout `None` →
/// 600, `async` defaulted to `false`).
///
/// The `matcher` key is **per-event**: `matcher_pattern_for_event` in
/// `codex-rs/hooks/src/events/common.rs` normalises the matcher to
/// `None` for `UserPromptSubmit` and `Stop` (matchers are meaningless
/// for those events) and `toml::Value` serialisation drops `None`
/// fields, so including `"matcher": ".*"` for those made every hash
/// mismatch and stranded raum's hooks in Codex's "new or changed"
/// review prompt on every launch. `PermissionRequest` *does* keep its
/// matcher, so it must be hashed with one — see
/// [`codex_event_has_matcher`].
pub(super) fn codex_hook_trusted_hash(event: &str, hook_script: &Path) -> String {
    let mut identity = json!({
        "event_name": codex_hook_event_label(event),
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
    if codex_event_has_matcher(event) {
        identity["matcher"] = json!(CODEX_HOOK_MATCHER);
    }
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
