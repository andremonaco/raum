//! Install the uniform `raum` Agent Skill into each harness's user-level skills
//! directory so agents running inside raum discover the `raum` CLI (notably
//! `raum worktree create <branch>`).
//!
//! The skill is a single `SKILL.md` — YAML frontmatter (`name` + `description`)
//! plus a Markdown body — in the cross-tool Agent Skills format. raum owns the
//! `raum/` subdirectory under each skills root and rewrites the file only when
//! its content changes, so [`install_raum_skill`] is idempotent and cheap to run
//! on every launch (it keeps the skill current across raum upgrades).
//!
//! Each target is gated on the harness's base config directory already existing,
//! so we only add the skill for harnesses the user actually has set up — we
//! never create a `~/.codex` / `~/.claude` tree from scratch.

use std::path::{Path, PathBuf};

/// The skill document, uniform across Claude Code, Codex, and OpenCode.
const RAUM_SKILL_MD: &str = r#"---
name: raum
description: >-
  Create git worktrees from inside a raum terminal using the `raum` CLI. Use
  when the user asks to create, spin up, add, or branch off a new git worktree
  (e.g. "make a worktree for feature X", "create a branch worktree") while
  working in a raum-managed project. Prefer this over running `git worktree add`
  directly.
---

# raum CLI

`raum` is the terminal orchestrator this session is running inside. It exposes a
CLI for creating git worktrees that honor the user's configured worktree
settings (placement + branch prefix), apply the project's hydration manifest
(copy/symlink rules), and run any pre/post-create scripts — exactly like the
raum GUI does.

## Create a worktree

```
raum worktree create <branch>
```

- `<branch>` names a **new** branch for the worktree. It must not already exist
  — the command creates the branch (like the GUI). If the branch already exists,
  the command fails; pick a new name (or check out the existing branch with
  plain `git worktree add` yourself).
- The worktree's location follows the user's **Settings → Worktrees** choice
  (nested / parent / custom). Don't choose a location yourself unless asked.
- Project context is detected automatically from the current pane
  (`$RAUM_PROJECT_SLUG`) or the current git repository — you normally only need
  to pass the branch name.

### Options

- `--base <ref>` — base ref/branch to root the new branch on.
- `--strategy nested|parent|custom` — override placement for this one worktree.
- `--path <pattern>` — custom path pattern (implies `--strategy custom`).
- `--project <slug>` — target a specific project explicitly.
- `--json` — print the result as JSON.

Run `raum worktree create --help` for the full reference.

## Why use it

`raum worktree create` does more than `git worktree add`: it applies the
project's hydration rules (so the new worktree has the env files, symlinks, etc.
it needs) and runs the configured pre/post-create scripts. The worktree is a
real git worktree on disk immediately; if the raum app is open it appears the
next time it refreshes its worktree list (e.g. when you interact with the
sidebar) or on restart.
"#;

/// Outcome of writing one harness's skill file.
#[derive(Debug, Clone)]
pub struct SkillWrite {
    /// Absolute path to the `SKILL.md`.
    pub path: PathBuf,
    /// `true` when the file was (re)written, `false` when it was already current.
    pub wrote: bool,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// OpenCode's user config directory: `$XDG_CONFIG_HOME/opencode` or
/// `~/.config/opencode`. Mirrors `opencode::default_settings_path`'s logic.
fn opencode_config_dir() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        let xdg = PathBuf::from(xdg);
        if !xdg.as_os_str().is_empty() {
            return Some(xdg.join("opencode"));
        }
    }
    Some(home()?.join(".config").join("opencode"))
}

/// `(gate_dir, skill_md_path)` per harness. The skill is written only when
/// `gate_dir` already exists.
fn skill_targets() -> Vec<(PathBuf, PathBuf)> {
    skill_targets_for(home().as_deref(), opencode_config_dir().as_deref())
}

/// Pure target computation (no env reads) so it can be unit-tested.
fn skill_targets_for(home: Option<&Path>, opencode_dir: Option<&Path>) -> Vec<(PathBuf, PathBuf)> {
    let skill_md = |base: &Path| base.join("skills").join("raum").join("SKILL.md");
    let mut out = Vec::new();
    if let Some(h) = home {
        let claude = h.join(".claude");
        out.push((claude.clone(), skill_md(&claude)));
        let codex = h.join(".codex");
        out.push((codex.clone(), skill_md(&codex)));
    }
    if let Some(oc) = opencode_dir {
        out.push((oc.to_path_buf(), skill_md(oc)));
    }
    out
}

/// Install the `raum` skill into every harness the user has set up. Idempotent:
/// only rewrites a file when its content differs. Never fails the caller —
/// per-target errors are logged and skipped.
pub fn install_raum_skill() -> Vec<SkillWrite> {
    let mut writes = Vec::new();
    for (gate, path) in skill_targets() {
        if !gate.exists() {
            continue;
        }
        match write_if_changed(&path, RAUM_SKILL_MD) {
            Ok(wrote) => writes.push(SkillWrite { path, wrote }),
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "install_raum_skill: write failed");
            }
        }
    }
    writes
}

fn write_if_changed(path: &Path, content: &str) -> std::io::Result<bool> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == content {
            return Ok(false);
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_has_valid_frontmatter() {
        assert!(RAUM_SKILL_MD.starts_with("---\n"));
        assert!(RAUM_SKILL_MD.contains("\nname: raum\n"));
        assert!(RAUM_SKILL_MD.contains("description:"));
        // Frontmatter terminator present after the opening block.
        assert!(RAUM_SKILL_MD[4..].contains("\n---\n"));
        assert!(RAUM_SKILL_MD.contains("raum worktree create"));
    }

    #[test]
    fn targets_cover_the_three_harnesses() {
        let home = PathBuf::from("/home/u");
        let oc = PathBuf::from("/home/u/.config/opencode");
        let targets = skill_targets_for(Some(&home), Some(&oc));
        let paths: Vec<String> = targets
            .iter()
            .map(|(_, p)| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            paths,
            vec![
                "/home/u/.claude/skills/raum/SKILL.md".to_string(),
                "/home/u/.codex/skills/raum/SKILL.md".to_string(),
                "/home/u/.config/opencode/skills/raum/SKILL.md".to_string(),
            ]
        );
        // Each gate is the harness base dir (one level above `skills/`).
        assert_eq!(targets[0].0, PathBuf::from("/home/u/.claude"));
    }

    #[test]
    fn write_if_changed_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("skills").join("raum").join("SKILL.md");
        assert!(
            write_if_changed(&path, RAUM_SKILL_MD).unwrap(),
            "first write"
        );
        assert!(
            !write_if_changed(&path, RAUM_SKILL_MD).unwrap(),
            "second write is a no-op"
        );
        assert!(
            write_if_changed(&path, "changed").unwrap(),
            "content change rewrites"
        );
    }
}
