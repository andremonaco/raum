//! CLI-bridge commands — support for opening raum in a directory from the
//! terminal (`raum <dir>`).
//!
//! Two halves:
//!
//! * [`cli_take_pending_open`] — drains the cold-start path captured in
//!   [`AppHandleState::pending_cli_open`] by `cli::parse_open_path` in `run()`.
//!   The frontend calls this once on boot and opens/focuses the project.
//! * [`cli_install_shim`] — installs a small `raum` launcher onto `PATH` so the
//!   command exists for users who drag the `.app` out of the DMG. Homebrew
//!   users get the same launcher via the cask `binary` stanza instead.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::state::AppHandleState;

/// Return (once) the directory passed at a cold launch, then clear it so a
/// later in-app reload (`Cmd+R`) doesn't re-open it. `None` for a plain `raum`
/// launch or after it has already been drained.
#[tauri::command]
pub fn cli_take_pending_open(state: tauri::State<'_, AppHandleState>) -> Option<String> {
    let mut pending = state.pending_cli_open.lock().ok()?;
    pending.take().map(|p| p.to_string_lossy().into_owned())
}

/// Result of [`cli_install_shim`]. `on_path` lets the UI tell the difference
/// between "installed and usable now" and "installed somewhere not on $PATH —
/// you must add it first".
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShimInstall {
    /// Absolute path the launcher was written to.
    pub path: String,
    /// Whether that path's directory is on the current `$PATH`.
    pub on_path: bool,
}

/// Install a `raum` launcher script onto `PATH`.
///
/// Writes a tiny `#!/bin/sh` wrapper that launches this app's binary detached
/// (`nohup … &`) so `raum <dir>` returns the shell prompt immediately while the
/// GUI keeps running. Prefers a directory that is *already on `$PATH`* (Homebrew
/// `/opt/homebrew/bin` or `/usr/local/bin`) so the command works immediately;
/// only if none is writable does it fall back to `~/.local/bin`, in which case
/// the returned `on_path` is `false` so the UI can tell the user to add it to
/// `$PATH`. An existing symlink at the target (e.g. a Homebrew cask symlink to
/// the bundled wrapper) is removed first rather than written through.
#[tauri::command]
pub fn cli_install_shim() -> Result<ShimInstall, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    let script = shim_script(&exe.to_string_lossy());

    let path_set = path_dirs();
    let candidates = install_candidates();
    // Try on-$PATH dirs first (usable immediately), then off-$PATH fallbacks.
    let ordered = candidates
        .iter()
        .filter(|d| path_set.contains(*d))
        .chain(candidates.iter().filter(|d| !path_set.contains(*d)));

    let mut last_err = String::from("no writable install directory found");
    for dir in ordered {
        if let Err(e) = std::fs::create_dir_all(dir) {
            last_err = format!("create_dir_all {}: {e}", dir.display());
            continue;
        }
        let target = dir.join("raum");
        match write_shim(&target, &script) {
            Ok(()) => {
                return Ok(ShimInstall {
                    path: target.to_string_lossy().into_owned(),
                    on_path: path_set.contains(dir),
                });
            }
            Err(e) => last_err = format!("write {}: {e}", target.display()),
        }
    }
    Err(last_err)
}

/// Best-effort, silent CLI-shim install for first-launch direct-download macOS
/// users, so `raum <dir>` works from a terminal without a manual menu click.
///
/// Deliberately restrained — it must "just work" or do nothing, never surprise
/// the user with system changes or `$PATH` edits:
///
/// * Skips Homebrew installs (the cask already puts `raum` on `$PATH`).
/// * Only writes into a candidate dir that is *already on `$PATH`* **and**
///   already exists — never creates system dirs, never uses the off-`$PATH`
///   `~/.local/bin` fallback (that one needs the user to fix `$PATH` first, so
///   it belongs to the explicit [`cli_install_shim`] menu action).
/// * Skips when an up-to-date shim is already present, but replaces a stale one
///   (e.g. after the `.app` was moved).
///
/// All errors are swallowed; the "Install 'raum' Terminal Command" menu item
/// remains the manual fallback/repair.
#[cfg(target_os = "macos")]
pub(crate) fn auto_install_shim_if_safe() {
    // Homebrew cask owns the `raum` binary on PATH; don't fight it.
    if crate::commands::updater::updater_install_flavor() == "homebrew" {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    let exe = exe.to_string_lossy();
    let script = shim_script(&exe);
    let quoted = shell_single_quote(&exe);

    let path_set = path_dirs();
    for dir in install_candidates() {
        // Must be usable immediately (on $PATH) and already exist — silent
        // installs never create new directories.
        if !path_set.contains(&dir) || std::fs::metadata(&dir).is_err() {
            continue;
        }
        let target = dir.join("raum");
        if std::fs::read_to_string(&target).is_ok_and(|c| shim_is_current(&c, &quoted)) {
            return; // already installed & pointing at this binary
        }
        if write_shim(&target, &script).is_ok() {
            return;
        }
    }
}

/// Whether `contents` is a raum shim already pointing at `quoted_exe` (the
/// shell-quoted current executable). Lets the auto-installer skip a rewrite
/// when the shim is current while still replacing a stale one.
#[cfg(target_os = "macos")]
fn shim_is_current(contents: &str, quoted_exe: &str) -> bool {
    contents.contains(quoted_exe)
}

/// Generate the `#!/bin/sh` launcher body for `exe`.
fn shim_script(exe: &str) -> String {
    format!(
        "#!/bin/sh\n\
         # raum CLI launcher (raum <dir>). Generated by \"Install 'raum' Terminal Command\".\n\
         # Launch detached so the shell returns immediately; argv + CWD are inherited.\n\
         nohup {exe} \"$@\" >/dev/null 2>&1 &\n",
        exe = shell_single_quote(exe),
    )
}

/// Write `script` to `target` as a 0755 file, replacing any existing symlink
/// (so we never write *through* a Homebrew cask symlink into the bundle).
fn write_shim(target: &Path, script: &str) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::symlink_metadata(target) {
        if meta.file_type().is_symlink() {
            let _ = std::fs::remove_file(target);
        }
    }
    std::fs::write(target, script.as_bytes())?;
    std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o755))
}

/// The directories currently on `$PATH`.
fn path_dirs() -> HashSet<PathBuf> {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default()
}

/// Candidate install directories, most-preferred first.
fn install_candidates() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local").join("bin"));
    }
    dirs
}

/// Wrap `s` in single quotes for safe embedding in the generated `/bin/sh`
/// script, escaping any embedded single quote the POSIX way.
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_wraps_plain_path() {
        assert_eq!(
            shell_single_quote("/Applications/raum.app/Contents/MacOS/raum"),
            "'/Applications/raum.app/Contents/MacOS/raum'"
        );
    }

    #[test]
    fn shell_quote_escapes_embedded_quote() {
        assert_eq!(shell_single_quote("/a'b/raum"), "'/a'\\''b/raum'");
    }

    #[test]
    fn install_candidates_prefers_homebrew_then_usr_local() {
        let dirs = install_candidates();
        assert_eq!(dirs[0], PathBuf::from("/opt/homebrew/bin"));
        assert_eq!(dirs[1], PathBuf::from("/usr/local/bin"));
    }

    #[test]
    fn shim_script_is_detached_and_quotes_the_exe() {
        let s = shim_script("/Apps/raum.app/Contents/MacOS/raum");
        assert!(s.starts_with("#!/bin/sh\n"), "missing shebang: {s}");
        assert!(
            s.contains("nohup '/Apps/raum.app/Contents/MacOS/raum' \"$@\" >/dev/null 2>&1 &"),
            "not detached / not quoted: {s}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn shim_is_current_detects_matching_exe() {
        const EXE: &str = "/Applications/raum.app/Contents/MacOS/raum";
        let quoted = shell_single_quote(EXE);
        // A freshly generated shim for EXE is "current"...
        assert!(shim_is_current(&shim_script(EXE), &quoted));
        // ...but a shim pointing at a different (e.g. moved) path is not.
        assert!(!shim_is_current(
            &shim_script("/Volumes/old/raum.app/Contents/MacOS/raum"),
            &quoted
        ));
    }

    #[test]
    fn write_shim_creates_an_executable_file() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("raum");
        write_shim(&target, "#!/bin/sh\nnohup x &\n").unwrap();
        let meta = std::fs::metadata(&target).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o755);
        assert!(
            std::fs::read_to_string(&target)
                .unwrap()
                .contains("nohup x")
        );
    }

    #[test]
    fn write_shim_replaces_a_symlink_instead_of_writing_through_it() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("bundled-wrapper");
        std::fs::write(&real, "ORIGINAL").unwrap();
        let link = tmp.path().join("raum");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        write_shim(&link, "NEWSCRIPT").unwrap();

        // The symlink's original target must be untouched...
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "ORIGINAL");
        // ...and the install path is now a fresh regular file with our script.
        assert!(
            !std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(std::fs::read_to_string(&link).unwrap(), "NEWSCRIPT");
    }
}
