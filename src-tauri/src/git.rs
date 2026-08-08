//! Shared constructors for every `git` subprocess raum spawns.
//!
//! Every invocation sets `GIT_OPTIONAL_LOCKS=0`. Without it, read-only-looking
//! commands (`git status`, `git diff`, …) opportunistically rewrite
//! `.git/index` to refresh the stat cache. That write feeds straight back into
//! the index watcher that triggers status recomputes — a perfect
//! self-oscillator — and can contend on `index.lock` with the user's own git
//! commands running in a pane.
//!
//! Use [`git_cmd`] when the repo is addressed by path (`git -C <path> …`) and
//! [`git_bare`] when the caller sets `current_dir` itself or runs git against
//! the inherited cwd.

use std::process::Command;

/// A bare `git` command with optional locks disabled. The caller supplies the
/// repo context (`.current_dir(…)`, or the inherited cwd).
pub(crate) fn git_bare() -> Command {
    let mut cmd = Command::new("git");
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    cmd
}

/// A `git -C <path> …` command with optional locks disabled.
pub(crate) fn git_cmd(path: &str) -> Command {
    let mut cmd = git_bare();
    cmd.args(["-C", path]);
    cmd
}
