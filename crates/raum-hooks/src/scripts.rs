//! Hook-script writer (§7.2). Filled in by Wave 1C.

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
    format!(
        "#!/usr/bin/env sh
{HEADER}set -eu
SOCK=\"${{RAUM_EVENT_SOCK:-}}\"
if [ -z \"$SOCK\" ]; then exit 0; fi
EVENT_NAME=\"${{1:-unknown}}\"
PAYLOAD=\"$(cat || true)\"
JSON=$(printf '{{\"harness\":\"%s\",\"event\":\"%s\",\"payload\":%s}}\\n' \\
  \"{harness}\" \"$EVENT_NAME\" \"$(printf '%s' \"$PAYLOAD\" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '\"\"')\")
# socat / nc fallback chain — silently no-op if neither is present.
if command -v socat >/dev/null 2>&1; then
  printf '%s' \"$JSON\" | socat - UNIX-CONNECT:\"$SOCK\" || true
elif command -v nc >/dev/null 2>&1; then
  printf '%s' \"$JSON\" | nc -U \"$SOCK\" || true
fi
exit 0
"
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
