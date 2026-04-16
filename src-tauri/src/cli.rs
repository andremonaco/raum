//! §2.7 — `raum --help` / `--version` print GUI-only help; no internal subcommands surfaced.
//!
//! `handle_args` is split from `main`'s argv so it can be unit-tested with
//! synthetic argument vectors without touching the real process environment.

use std::io::Write;

const HELP: &str = "raum — lightning-fast, recoverable terminals for AI agent harnesses

USAGE:
    raum            Open the GUI window. There is no CLI surface; everything happens in-app.

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
}
