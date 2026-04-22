//! Ensure the bundled `.app` sees the user's real shell environment.
//!
//! macOS hands apps launched from Finder a minimal environment: a sparse
//! `PATH` (usually `/usr/bin:/bin:/usr/sbin:/sbin`) and no `LANG` /
//! `LC_ALL`. `cargo tauri dev` inherits the shell environment so
//! development feels fine, but in a shipped bundle:
//!   * `which::which()` for `claude`, `codex`, `opencode` fails — the
//!     harness-detection UI shows only `shell` as available.
//!   * Harness TUIs fall back to the C locale and render Unicode
//!     box-drawing characters (`╭─╮│╰╯⎿✻`) as ASCII `_`/`?` — the panes
//!     end up full of underscores instead of the real TUI chrome.
//!
//! We fix both at startup by probing the user's login shell for `PATH`
//! and locale vars, merging them into the process environment, and
//! falling back to sensible defaults (well-known dev dirs + UTF-8) when
//! the probe fails.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use tracing::{info, warn};

/// How long we wait for the shell probe before giving up. Interactive
/// shells with heavy rc files (nvm, oh-my-zsh, …) can take ~200–600 ms on
/// cold start; 1500 ms is conservative without making startup feel slow.
const SHELL_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// Sentinels the probe script wraps around each captured env var so we
/// can extract values cleanly even if the user's rc files print banners
/// or warnings to stdout.
const START_MARKER: &str = "__RAUM_ENV_START__";
const END_MARKER: &str = "__RAUM_ENV_END__";

/// Env vars we want to pull from the user's login shell. `PATH` drives
/// harness resolution; the locale vars keep Unicode TUI chrome from
/// being mangled to `_`. Order is the preference order for locale:
/// `LC_ALL` wins over `LANG` when both are set.
const PROBED_VARS: &[&str] = &["PATH", "LANG", "LC_ALL", "LC_CTYPE"];

/// Fallback locale when neither the shell probe nor the existing process
/// env has a usable value. `en_US.UTF-8` is near-universally present on
/// macOS and every mainstream Linux distro.
const DEFAULT_LOCALE: &str = "en_US.UTF-8";

/// Prepend the user's interactive-shell `PATH` and well-known developer
/// directories to the current process's `PATH`. Idempotent per run; only
/// the *additions* are logged so the delta is visible.
pub fn augment_process_path() {
    let existing_path = std::env::var("PATH").unwrap_or_default();
    let existing_lang = std::env::var("LANG").unwrap_or_default();
    let existing_lc_all = std::env::var("LC_ALL").unwrap_or_default();
    let shell_env = std::env::var("SHELL").unwrap_or_default();
    info!(
        path = %existing_path,
        lang = %existing_lang,
        lc_all = %existing_lc_all,
        shell = %shell_env,
        "path_env: initial environment"
    );

    let probed = login_shell_env().unwrap_or_default();

    // --- PATH: merge login-shell PATH + well-known dev dirs into existing ---
    let mut additions: Vec<PathBuf> = Vec::new();
    if let Some(p) = probed.get("PATH") {
        info!(path = %p, "path_env: login shell PATH resolved");
        additions.extend(split_path(p));
    } else {
        warn!("path_env: login shell PATH probe failed; using well-known dirs only");
    }
    additions.extend(well_known_dirs());
    let merged_path = merge_paths(&existing_path, additions);
    if merged_path == existing_path {
        info!("path_env: PATH already contains all candidate directories");
    } else {
        set_env("PATH", &merged_path);
        let existing_set: std::collections::HashSet<PathBuf> =
            split_path(&existing_path).into_iter().collect();
        let prepended: Vec<String> = split_path(&merged_path)
            .into_iter()
            .filter(|p| !existing_set.contains(p))
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        info!(count = prepended.len(), added = ?prepended, "path_env: PATH augmented");
    }

    // --- Locale: LANG / LC_ALL / LC_CTYPE — only set if missing. Prefer the
    // login-shell value; fall back to en_US.UTF-8 so harness TUIs don't
    // render Unicode chrome as underscores.
    for var in ["LANG", "LC_ALL", "LC_CTYPE"] {
        let already = std::env::var(var).ok().filter(|v| !v.is_empty());
        if already.is_some() {
            continue;
        }
        let value = probed
            .get(var)
            .filter(|v| !v.is_empty())
            .cloned()
            .unwrap_or_else(|| DEFAULT_LOCALE.to_string());
        set_env(var, &value);
        info!(var = %var, value = %value, "path_env: locale var set");
    }
}

fn set_env(key: &str, value: &str) {
    // SAFETY: `set_var` is marked `unsafe` in Rust 2024 because other threads
    // may read the environment concurrently. We invoke this exactly once at
    // startup before the Tauri builder spawns any workers, so no concurrent
    // reader exists. See the workspace-level note in the root `Cargo.toml`.
    #[allow(unsafe_code)]
    unsafe {
        std::env::set_var(key, OsString::from(value));
    }
}

/// Run the user's login shell and capture the vars in [`PROBED_VARS`].
/// Tries `-ilc` first (interactive login — picks up nvm/mise/asdf/volta
/// /brew shims defined in `.zshrc`/`.bashrc`), then falls back to `-lc`
/// if the interactive probe fails, errors, or times out (some rc files
/// early-exit on non-TTY stdin).
fn login_shell_env() -> Option<std::collections::HashMap<String, String>> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(default_shell);

    for args in [["-ilc"], ["-lc"]] {
        match probe_with(&shell, &args) {
            Ok(env) => return Some(env),
            Err(reason) => {
                warn!(shell = %shell, flags = ?args, reason = %reason, "path_env: shell probe attempt failed");
            }
        }
    }
    None
}

fn probe_with(
    shell: &str,
    flags: &[&str],
) -> Result<std::collections::HashMap<String, String>, String> {
    // For each var: emit `START<name>=<value>END`. Printing all vars in one
    // script keeps probe overhead to a single shell spawn.
    use std::fmt::Write as _;
    let mut script = String::new();
    for var in PROBED_VARS {
        let _ = write!(
            script,
            r#"printf '{s}{v}=%s{e}' "${v}";"#,
            s = START_MARKER,
            e = END_MARKER,
            v = var,
        );
    }

    let shell = shell.to_string();
    let flags: Vec<String> = flags.iter().map(|s| s.to_string()).collect();

    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let result = Command::new(&shell)
            .args(&flags)
            .arg(&script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output();
        let _ = tx.send(result);
    });

    let output = match rx.recv_timeout(SHELL_PROBE_TIMEOUT) {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(format!("spawn failed: {e}")),
        Err(_) => {
            return Err(format!(
                "timed out after {}ms",
                SHELL_PROBE_TIMEOUT.as_millis()
            ));
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "exit status {:?}; stderr: {}",
            output.status.code(),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let env = parse_probe_output(&stdout);
    if env.is_empty() {
        return Err(format!(
            "no markers found; stdout (truncated): {}",
            &stdout.chars().take(200).collect::<String>()
        ));
    }

    // Sanity: PATH is the whole point of this probe. If it's absent or has
    // no absolute entries, treat the whole attempt as failed so the caller
    // can try the next flag set before falling back to well-known dirs.
    match env.get("PATH") {
        Some(path) if path.split(':').any(|p| p.starts_with('/')) => Ok(env),
        Some(path) => Err(format!("probe yielded unusable PATH: {path:?}")),
        None => Err("probe did not include PATH".into()),
    }
}

fn parse_probe_output(stdout: &str) -> std::collections::HashMap<String, String> {
    let mut env = std::collections::HashMap::new();
    let mut rest = stdout;
    while let Some(start_idx) = rest.find(START_MARKER) {
        let after_start = &rest[start_idx + START_MARKER.len()..];
        let Some(end_idx) = after_start.find(END_MARKER) else {
            break;
        };
        let chunk = &after_start[..end_idx];
        rest = &after_start[end_idx + END_MARKER.len()..];
        if let Some((name, value)) = chunk.split_once('=') {
            if !name.is_empty() {
                env.insert(name.to_string(), value.to_string());
            }
        }
    }
    env
}

#[cfg(target_os = "macos")]
fn default_shell() -> String {
    "/bin/zsh".into()
}

#[cfg(not(target_os = "macos"))]
fn default_shell() -> String {
    "/bin/bash".into()
}

/// Well-known developer tool directories, used both as a safety net when
/// the shell probe fails and as a belt-and-suspenders guarantee that
/// common harness install locations are present.
fn well_known_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
    ];
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join(".bun/bin"));
        dirs.push(home.join(".volta/bin"));
    }
    dirs
}

fn split_path(path: &str) -> Vec<PathBuf> {
    path.split(':')
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect()
}

/// Prepend `additions` (in order, deduped) to `existing`, preserving the
/// original order of `existing` and dropping duplicates within `additions`.
fn merge_paths(existing: &str, additions: impl IntoIterator<Item = PathBuf>) -> String {
    let existing_entries = split_path(existing);
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    for dir in additions {
        if dir.as_os_str().is_empty() {
            continue;
        }
        if seen.insert(dir.clone()) {
            out.push(dir);
        }
    }
    for dir in existing_entries {
        if seen.insert(dir.clone()) {
            out.push(dir);
        }
    }

    out.iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_paths_prepends_new_entries() {
        let merged = merge_paths(
            "/usr/bin:/bin",
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
            ],
        );
        assert_eq!(merged, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    }

    #[test]
    fn merge_paths_deduplicates_against_existing() {
        let merged = merge_paths(
            "/usr/bin:/usr/local/bin:/bin",
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
            ],
        );
        // `/usr/local/bin` is already in `existing`; the addition wins its
        // slot (so it's ordered among additions), and the existing-side
        // duplicate is dropped — no duplicates in the final PATH.
        assert_eq!(merged, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    }

    #[test]
    fn merge_paths_deduplicates_within_additions() {
        let merged = merge_paths(
            "/bin",
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
            ],
        );
        assert_eq!(merged, "/opt/homebrew/bin:/usr/local/bin:/bin");
    }

    #[test]
    fn merge_paths_ignores_empty_segments() {
        let merged = merge_paths(
            "::/usr/bin:",
            vec![PathBuf::from(""), PathBuf::from("/new")],
        );
        assert_eq!(merged, "/new:/usr/bin");
    }

    #[test]
    fn merge_paths_noop_when_all_present() {
        let merged = merge_paths(
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
            ],
        );
        assert_eq!(merged, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    }

    #[test]
    fn split_path_drops_empties() {
        let entries = split_path(":/a::/b:");
        assert_eq!(entries, vec![PathBuf::from("/a"), PathBuf::from("/b")]);
    }
}
