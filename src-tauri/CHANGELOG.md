# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.16](https://github.com/andremonaco/raum/releases/tag/v0.1.16) - 2026-08-04

### Fixed

- fix(homebrew): drop stale bin/raum symlink before linking the cask binary —
  `brew upgrade --cask raum` failed with "It seems there is already a Binary at
  '/opt/homebrew/bin/raum'" for anyone whose install predates 0.1.11


## [0.1.15](https://github.com/andremonaco/raum/releases/tag/v0.1.15) - 2026-08-03

### Fixed

- fix(lint): drop redundant refs flagged by clippy 1.97
- perf(snapshots): move terminal snapshots over raw-byte IPC
- perf(wake): thin out the focus edge — throttle reconcile, stagger WebGL restore
- fix(webview): probe patiently before reloading a page that may just be waking
- fix(hooks): expire parked permission requests instead of leaking them
- fix(agents): drop unroutable hook events instead of broadcasting them

### Other

- docs: correct stale constants and architecture notes


## [0.1.14](https://github.com/andremonaco/raum/releases/tag/v0.1.14) - 2026-07-05

### Fixed

- fix(hooks): treat post-read peer close as delivered in reply()
- fix(notifications): stop reload from replaying seen completions
- fix(sidebar): self-heal frozen live git diffstat


## [0.1.13](https://github.com/andremonaco/raum/releases/tag/v0.1.13) - 2026-06-28

### Added

- feat(app): nested worktree default, terminals auto-dock config, menu items
- feat(worktree): per-worktree working-tree fs watcher for instant status
- feat(cli): `raum worktree create` + raum Agent Skill

### Fixed

- fix(tmux): treat dead-server stderr as no live sessions

### Other

- refactor(watcher): share notify self-heal scaffolding via notify_watch
- refactor(worktree): make working-tree fs watcher gitignore-aware and fd-bounded


## [0.1.12](https://github.com/andremonaco/raum/releases/tag/v0.1.12) - 2026-06-26


## [0.1.11](https://github.com/andremonaco/raum/releases/tag/v0.1.11) - 2026-06-25

### Added

- feat(projects): opt-in auto-hide of inactive project tabs
- feat(grid): drag-to-rearrange overhaul — grip handles + self-fitting harness ghost

### Fixed

- fix(recovery): make close/reopen/computer-restart sustainably recoverable


## [0.1.10](https://github.com/andremonaco/raum/releases/tag/v0.1.10) - 2026-06-24


## [0.1.9](https://github.com/andremonaco/raum/releases/tag/v0.1.9) - 2026-06-15

### Added

- feat(backend): control-mode transport, worktree status service, webview health

### Fixed

- fix(sessions): make sessions.toml the single authority + reconcile orphan tmux sessions

### Other

- refactor(review): brief hands reviewer the session log + changed files, no priming


## [0.1.8](https://github.com/andremonaco/raum/releases/tag/v0.1.8) - 2026-05-13


## [0.1.7](https://github.com/andremonaco/raum/releases/tag/v0.1.7) - 2026-05-10

### Fixed

- fix(notifications): drop test cfg from kind field gate (Linux clippy --tests)
- fix(notifications): cfg-gate SendNotificationArgs::kind for Linux clippy
- fix(notifications): skip UNUserNotificationCenter calls in unbundled dev


## [0.1.6](https://github.com/andremonaco/raum/releases/tag/v0.1.6) - 2026-05-09

### Added

- feat(harness): post-reboot terminal recovery via harness --resume

### Fixed

- fix(notifications): cfg-gate macOS-only identifier helpers for Linux clippy
- fix(harness): Codex 0.130 hooks — rename feature flag and pre-seed trust hash


## [0.1.5](https://github.com/andremonaco/raum/releases/tag/v0.1.5) - 2026-05-07


## [0.1.4](https://github.com/andremonaco/raum/releases/tag/v0.1.4) - 2026-05-07

### Added

- feat(harness): provider-replay recovery, dwell-armed review snap, file-drop overlay
- feat(review): cross-harness review via drag-and-drop snap
- feat(worktree): merge worktree from sidebar with step-progress dialog
- feat(layout): persist active project + per-project worktree scope across restarts

### Fixed

- fix(tmux): forward focus-events to the inner harness; ignore .raum/

### Other

- test(tmux): assert burst preservation via capture-pane, not PTY bytes
- test(tmux): widen burst-marker deadline to 20s for slow Linux CI
- refactor: split mega-modules and add cross-restart terminal snapshots
- refactor(tmux): extract StreamCoalescer into its own module


## [0.1.3](https://github.com/andremonaco/raum/releases/tag/v0.1.3) - 2026-04-28

### Added

- feat: dead-pane recovery, orphan reaper, off-tree minimize, streamed op progress
- feat(tabs): show last user prompt as a subtitle on each terminal tab
- feat(grid): live drag preview with ghost surface and responsive resize

### Fixed

- fix(tmux): join hard-wrapped scrollback rows in capture-pane
- fix(startup): swap kqueue→fsevent and stop deleting tmux's prefix table
- fix(deps): pull libc on linux too so the fd probe builds in CI
- perf(reattach): paint a bounded viewport snapshot + pre-resize tmux
- fix(git-watcher): rate-limit notify warns + supervisor rebuild on EMFILE pressure
- fix(harness): split Claude/Codex hook dispatchers + Python fast path
- fix(terminal): recover the PTY bridge in place instead of marking the pane dead
- fix(macos): raise RLIMIT_NOFILE on startup so tmux stops hitting EMFILE
- perf(backend): batch sidebar/poller IPC + non-blocking harness preflight

### Other

- test(tmux): break unique_socket nanos collision with an atomic counter
- ci(release): enable Developer ID signing + notarization


## [0.1.2](https://github.com/andremonaco/raum/releases/tag/v0.1.2) - 2026-04-24

### Added

- *(sidebar)* native open-file via OS handler, in-app CodeMirror editor, click-to-switch branch badge with dirty-tree guard, dir-based GitHeadWatcher that survives macOS atomic HEAD rename ([#20](https://github.com/andremonaco/raum/pull/20))

### Fixed

- *(release)* re-enable automatic release pipeline — replace release-plz release-pr (which silently no-ops on publish=false workspaces because crates.io lookup 404s) with a repo-local `propose-release` workflow that opens the bump PR from conventional commits; marks internal crates as publish=false so the tag cargo-package path is consistent

## [0.1.1](https://github.com/andremonaco/raum/releases/tag/v0.1.1) - 2026-04-23

### Added

- *(notifications)* banner master switch + native macOS auth probe + focus-gated toasts
- *(homebrew)* strip quarantine in cask postflight ([#13](https://github.com/andremonaco/raum/pull/13))

### Fixed

- *(terminal)* smaller reattach threshold + restore Option-char composition + honour xterm hotkeys
- *(sidebar)* drop duplicated Agents list; surface ahead/behind + stash count
- *(dialogs)* widen destructive + settings modals and normalise padding
- *(macos)* force-hide NSWindow title after switching to overlay titlebar
- *(worktree)* replace stale `{root}` token with `{repo-root}` and validate custom patterns
- *(vite)* exclude overlayscrollbars-solid from dep optimizer ([#11](https://github.com/andremonaco/raum/pull/11))
- *(bundle)* emit DMG so Homebrew cask bump can hash + link it ([#5](https://github.com/andremonaco/raum/pull/5))
- *(release)* use gh release download for draft-asset sha256 ([#7](https://github.com/andremonaco/raum/pull/7))
- *(release)* drop empty APPLE_* env vars so macOS build falls back to ad-hoc sign ([#4](https://github.com/andremonaco/raum/pull/4))

### Other

- *(grid)* in-place cross-project projection + shared tab-label lookup
- *(onboarding)* 4 steps → intro + 3 steps with harness check merged into prereqs
- *(build)* strip third-party debug symbols + add `task target:sweep`
- *(dev)* separate product identity for dev builds
- *(release)* cross-compile macOS x86_64 on arm64 runner ([#6](https://github.com/andremonaco/raum/pull/6))
- *(hydration)* retry hook exec on ETXTBSY for parallel-test races ([#12](https://github.com/andremonaco/raum/pull/12))
- *(tmux)* pin server-lifetime options before new-session via tmux command chain ([#10](https://github.com/andremonaco/raum/pull/10))
- *(tmux)* pin exit-empty/exit-unattached off in capture-pane tests ([#8](https://github.com/andremonaco/raum/pull/8))

## [0.1.0](https://github.com/andremonaco/raum/releases/tag/v0.1.0) - 2026-04-22

### Added

- *(hooks)* blocking PermissionRequest handler + session-scoped events
- in-app updater UI, periodic update checks, and Homebrew distribution

### Fixed

- *(hooks)* preserve trailing newline when sending event-socket frames
- *(clippy)* align with rust 1.95 stable
- quell more rust 1.95 clippy lints
- quell clippy::map_unwrap_or (rust 1.95 lint)

### Other

- *(release)* ad-hoc macOS sign + pin tauri-action@v0.6.2 ([#2](https://github.com/andremonaco/raum/pull/2))
- *(icons)* grow squircle background to 900x900 (88% canvas fill)
- *(icons)* regenerate app assets from updated RaumLogo mark
- *(hooks)* capture sh -x traces from hook-script subprocesses
- snapshot socat fix, project-scoped grid, event-sound playback
- snapshot cross-project spotlight, notification probe, harness polish
- snapshot in-progress work across harness, tmux, and frontend
- *(harness)* split AgentAdapter into identity + setup + runtime traits
- initial commit
