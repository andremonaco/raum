//! §2.7 — `raum --help` / `--version` print GUI-only help; no internal subcommands surfaced.
//!
//! `handle_args` is split from `main`'s argv so it can be unit-tested with
//! synthetic argument vectors without touching the real process environment.
//!
//! A single optional positional argument — a directory — opens that folder as
//! a project (`raum .` / `raum /path/to/repo`). `parse_open_path` resolves it
//! against the launch CWD; the resolved absolute path is then handed to the
//! frontend (cold start via `cli_take_pending_open`, already-running instance
//! via the `cli-open-project` event emitted from the single-instance callback).

use std::io::Write;
use std::path::{Path, PathBuf};

const HELP: &str = "raum — lightning-fast, recoverable terminals for AI agent harnesses

USAGE:
    raum [DIR]      Open the GUI window. Pass a directory to open it as a project
                    — added if new, focused if already registered.

OPTIONS:
    -h, --help      Show this message
    -V, --version   Show version
";

/// Dispatch command-line args.
///
/// Returns `true` when the caller should continue booting the GUI; `false`
/// when the program has already handled the request (e.g. `--help`) and
/// should exit cleanly.
#[must_use]
pub fn handle_args() -> bool {
    handle_args_with(std::env::args().skip(1), &mut std::io::stdout())
}

#[must_use]
pub fn handle_args_with<I, S>(args: I, out: &mut dyn Write) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for arg in args {
        match arg.as_ref() {
            "-h" | "--help" => {
                let _ = writeln!(out, "{HELP}");
                return false;
            }
            "-V" | "--version" => {
                let _ = writeln!(out, "raum {}", env!("CARGO_PKG_VERSION"));
                return false;
            }
            _ => {
                // Internal flags are intentionally not advertised. Ignore unknown args silently.
            }
        }
    }
    true
}

/// Resolve the optional positional directory argument to an absolute,
/// canonical path.
///
/// `args` is the argument vector *after* the program name (`argv[0]`). The
/// first non-empty, non-flag entry is treated as the path; flags (`-…`) and
/// empties are skipped so this composes with [`handle_args`]. A relative path
/// is joined against `cwd` (the launch working directory). The result is run
/// through [`std::fs::canonicalize`] so symlinks and `..` collapse and the
/// frontend's path-based project lookup compares like-for-like. When the
/// argument points at a file, its parent directory is used. Returns `None`
/// when there is no path argument or it does not resolve to an existing entry.
#[must_use]
pub fn parse_open_path<I, S>(args: I, cwd: &Path) -> Option<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let raw = args
        .into_iter()
        .find(|a| !a.as_ref().is_empty() && !a.as_ref().starts_with('-'))?;
    let raw = raw.as_ref();
    let joined = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        cwd.join(raw)
    };
    let canon = std::fs::canonicalize(&joined).ok()?;
    if canon.is_dir() {
        Some(canon)
    } else {
        canon.parent().map(Path::to_path_buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(args: &[&str]) -> (bool, String) {
        let mut buf: Vec<u8> = Vec::new();
        let cont = handle_args_with(args.iter().copied(), &mut buf);
        (cont, String::from_utf8(buf).unwrap())
    }

    #[test]
    fn no_args_continues_to_gui() {
        let (cont, out) = run(&[]);
        assert!(cont);
        assert!(out.is_empty());
    }

    #[test]
    fn help_short_prints_and_stops() {
        let (cont, out) = run(&["-h"]);
        assert!(!cont);
        assert!(out.contains("GUI-only") || out.contains("Open the GUI window"));
        assert!(!out.contains("hook"));
        assert!(!out.contains("sessions"));
    }

    #[test]
    fn help_long_prints_and_stops() {
        let (cont, out) = run(&["--help"]);
        assert!(!cont);
        assert!(out.contains("Open the GUI window"));
    }

    #[test]
    fn version_short_prints_and_stops() {
        let (cont, out) = run(&["-V"]);
        assert!(!cont);
        assert!(out.starts_with("raum "));
    }

    #[test]
    fn version_long_prints_and_stops() {
        let (cont, out) = run(&["--version"]);
        assert!(!cont);
        assert!(out.starts_with("raum "));
    }

    #[test]
    fn unknown_flags_silently_allow_continue() {
        let (cont, out) = run(&["--internal-reap-sessions"]);
        assert!(cont);
        assert!(out.is_empty());
    }

    #[test]
    fn help_surface_does_not_mention_any_subcommand() {
        // Enforced for §2.7: internal subcommands MUST NOT appear in --help.
        let (_, out) = run(&["--help"]);
        for forbidden in ["hook", "session", "reap", "subcommand"] {
            assert!(
                !out.to_lowercase().contains(forbidden),
                "help leaks `{forbidden}`: {out}"
            );
        }
    }

    #[test]
    fn open_path_resolves_relative_dot_against_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = std::fs::canonicalize(tmp.path()).unwrap();
        assert_eq!(parse_open_path(["."], &cwd), Some(cwd.clone()));
    }

    #[test]
    fn open_path_resolves_absolute_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = std::fs::canonicalize(tmp.path()).unwrap();
        let elsewhere = std::env::temp_dir();
        assert_eq!(
            parse_open_path([dir.to_str().unwrap()], &elsewhere),
            Some(dir)
        );
    }

    #[test]
    fn open_path_for_a_file_returns_its_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = std::fs::canonicalize(tmp.path()).unwrap();
        let file = dir.join("README.md");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(
            parse_open_path([file.to_str().unwrap()], &std::env::temp_dir()),
            Some(dir)
        );
    }

    #[test]
    fn open_path_skips_flags_and_takes_first_path() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = std::fs::canonicalize(tmp.path()).unwrap();
        // Leading flags are ignored; the first bare arg wins.
        assert_eq!(
            parse_open_path(
                ["-h", "--foo", dir.to_str().unwrap()],
                &std::env::temp_dir()
            ),
            Some(dir)
        );
    }

    #[test]
    fn open_path_none_for_flags_only() {
        assert_eq!(
            parse_open_path(["-h", "--version"], &std::env::temp_dir()),
            None
        );
    }

    #[test]
    fn open_path_none_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = std::fs::canonicalize(tmp.path()).unwrap();
        assert_eq!(parse_open_path(["definitely-not-here-9f3c"], &cwd), None);
    }

    #[test]
    fn open_path_none_when_no_args() {
        let no_args: [&str; 0] = [];
        assert_eq!(parse_open_path(no_args, &std::env::temp_dir()), None);
    }
}
