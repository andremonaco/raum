# raum release process

This document covers how to cut and ship a signed, notarized raum
release. The automation lives in `.github/workflows/release.yml`,
driven by [release-plz](https://release-plz.ieni.dev/). It runs on every
push to `main` and also supports manual `workflow_dispatch`.

Why release-plz (vs. semantic-release or hand-tagging):

- **Release-PR model**. Every proposed release lands as a reviewable PR
  before any tag or artifact exists. Nothing ships behind your back.
- **Rust-native**. It understands Cargo workspaces, updates
  `Cargo.toml` + `Cargo.lock` atomically, and plays well with
  `tauri-action` downstream.
- **Narrow bumps by construction**. The PR is a proposal. If
  release-plz suggests a minor you weren't ready for, edit the version
  in `src-tauri/Cargo.toml` on the release branch and merge the PR at
  your number. No commit-message gymnastics required.

## Versioning policy (pre-1.0)

raum is pre-1.0. To avoid racing to `0.7.0` on routine work, the
default release-plz proposal is overridden by the maintainer at PR
review time. The convention:

| Change shape                                                      | Target version |
| ----------------------------------------------------------------- | -------------- |
| Ordinary feature, fix, perf, revert                               | patch (`0.1.x`) |
| Milestone cut (a block of features you want to mark as a version) | minor (`0.x.0`) |
| Breaking change                                                   | patch — until we cut 1.0 |

Release-plz's commit analyzer will often propose a minor on `feat:`
commits. Take it as a draft: bump down to a patch in the release PR
unless the feature set truly warrants `0.x.0`. Major bumps (`1.0.0`)
are a deliberate manual cutover, not part of the automated flow.

### Which commits trigger a release PR

`release-plz.toml` sets `release_commits = "^(feat|fix|perf|revert)..."`,
so the PR only opens once at least one user-visible commit has landed
since the last release. Pure `chore:` / `docs:` / `ci:` / `style:` /
`test:` runs stay quiet.

## Artifacts

Each release builds three bundles with matching Tauri updater manifests:

| Platform       | Target triple          | Artifact                |
| -------------- | ---------------------- | ----------------------- |
| macOS (arm64)  | `aarch64-apple-darwin` | `raum_<version>_aarch64.dmg` |
| macOS (x86_64) | `x86_64-apple-darwin`  | `raum_<version>_x64.dmg`     |
| Linux (x86_64) | native                 | `raum_<version>_amd64.AppImage`, `raum_<version>_amd64.deb` |

The Tauri updater manifest (`latest.json`) is generated and uploaded by
`tauri-apps/tauri-action@v0` alongside the bundles.

## Required signing secrets

These are stored as GitHub Actions secrets on the `andremonaco/raum`
repository. Without them the release workflow can produce artifacts but
cannot sign / notarize them.

### macOS code signing + notarization

Notarization runs via the App Store Connect API key path (durable for
CI, rotation-friendly). The Apple ID + app-specific password path is
the documented alternative; switching back means swapping the three
`APPLE_API_*` secrets for `APPLE_ID` + `APPLE_PASSWORD` and dropping
the decode step in `release.yml`.

| Secret                        | Purpose                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `APPLE_CERTIFICATE`           | Base64-encoded `.p12` containing the Developer ID Application cert. |
| `APPLE_CERTIFICATE_PASSWORD`  | Password for the `.p12` bundle.                             |
| `APPLE_SIGNING_IDENTITY`      | Identity string, e.g. `"Developer ID Application: Your Name (TEAMID)"`. |
| `APPLE_TEAM_ID`               | Developer Team ID (10-character string).                    |
| `APPLE_API_ISSUER`            | App Store Connect Issuer ID (UUID, top of the Team Keys page). |
| `APPLE_API_KEY`               | App Store Connect Key ID (10-character alphanumeric).       |
| `APPLE_API_KEY_BASE64`        | Base64-encoded `.p8` private key. The release workflow decodes this to a file at runtime and sets `APPLE_API_KEY_PATH` for `tauri-action`. |

Generate the `.p8` once at App Store Connect → Users and Access →
Integrations → App Store Connect API → Team Keys (Developer role is
sufficient for notarization). Apple lets you download the `.p8`
exactly once — store the original alongside the secrets in your
password manager, since revocation + regeneration is the only recovery
path.

### Tauri updater signing

| Secret                             | Purpose                                           |
| ---------------------------------- | ------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`        | The ed25519 private key generated via `bun tauri signer generate`. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password protecting that key (empty string allowed). |

Regenerate via `bun tauri signer generate -w key.pem`. Paste the private
key body (between the BEGIN/END markers, newlines preserved) into the
secret; paste the public key body into
`src-tauri/tauri.conf.json → plugins.updater.pubkey`.

### Linux signing (optional)

The `.deb` and `.AppImage` bundles are shipped unsigned today. If you want
signed `.deb`s, add `LINUX_GPG_KEY` (ASCII-armored private key) + a
`dpkg-sig` step to the workflow.

## Cutting a release

1. **Commit style.** Commits on `main` must follow
   [Conventional Commits](https://www.conventionalcommits.org/) so
   release-plz can classify them. Only `feat` / `fix` / `perf` /
   `revert` trigger a release PR; everything else is quiet.
2. **Review the release PR.** As soon as a user-visible commit lands,
   the `release-pr` job opens (or updates) a PR titled
   `chore: release vX.Y.Z` containing:
   - bumped `version` in `src-tauri/Cargo.toml`
   - updated `Cargo.lock`
   - updated `CHANGELOG.md`

   **This is the bump control point.** If release-plz proposed `0.2.0`
   but you want `0.1.4`, edit `src-tauri/Cargo.toml` on the PR branch
   (and adjust the changelog heading if you like), push, then merge.
3. **Merge the PR.** The merge commit triggers the `release` job,
   which:
   - pushes tag `vX.Y.Z`
   - creates a **draft** GitHub Release named `raum vX.Y.Z` with the
     changelog entry as its body
4. **Artifacts build automatically.** The `build` matrix fires when the
   `release` job outputs `releases_created == true`. It checks out the
   new tag, builds each target (`macos-arm64`, `macos-x86_64`,
   `linux-x86_64`), signs + notarizes `.dmg`s, signs bundles with the
   Tauri updater key, and attaches everything plus `latest.json` to the
   draft release.
5. **Publish the draft** on GitHub once the post-release smoke test
   passes. The updater feed at
   `https://github.com/andremonaco/raum/releases/latest/download/latest.json`
   resolves automatically.

### Files updated per release

release-plz only rewrites Cargo manifests. The other version sources
resolve transitively:

- `src-tauri/Cargo.toml` — release-plz bumps this on every release.
- `src-tauri/tauri.conf.json` — the `version` field has been removed
  intentionally; Tauri's bundler + updater fall back to `Cargo.toml`,
  so there's nothing to sync.
- `crates/*/Cargo.toml` — internal path-only deps. They have
  `release = false` in `release-plz.toml` and stay at their current
  versions forever. Not shipped, not published.
- `frontend/package.json` — not user-facing; its `version` field is
  informational only and not kept in lockstep.

### Bootstrapping (one-time)

release-plz resolves the last release from existing `v*` tags. Before
the very first automated run, seed the current version so the first
proposal starts from `0.1.0` rather than `0.0.0`:

```sh
git tag v0.1.0
git push origin v0.1.0
```

### Manual reruns

Use the **Run workflow** button on the `release` action. Both
release-plz jobs are idempotent — they no-op when there's no pending
work.

<!-- TODO(§14.6): Publishing the first notarized draft still requires a
maintainer with the Apple Developer ID certificates and the Tauri updater
signing key configured as GitHub Actions secrets. Once those are in
place, the seed tag above kicks the automation into life and subsequent
releases are hands-off until the publish step. Until then the DMGs are
ad-hoc signed and the Homebrew cask strips `com.apple.quarantine` in a
`postflight` block (`packaging/homebrew/Casks/raum.rb`) so brew users
don't hit the Gatekeeper "cannot verify" dialog; the Apple env vars to
re-enable are at `.github/workflows/release.yml:107-120`. -->

## Post-release smoke test (§14.7)

Run the following checklist on a fresh macOS and a fresh Linux VM (no prior
raum install). This is the minimum acceptance for a release — it covers
install-path wiring, recovery, presets, and search.

- [ ] macOS VM: install via `brew install --cask andremonaco/raum/raum` on
      the bumped tap, launch from Finder. Gatekeeper should not complain.
      (If it does, the cask's `postflight` quarantine strip didn't run — or,
      once notarization is enabled, the notarization step failed.) Direct
      `.dmg` downloads still hit Gatekeeper today; that path will clear when
      Developer ID signing lands.
- [ ] Linux VM (Ubuntu): install the `.deb` with
      `sudo dpkg -i raum_*_amd64.deb`. Launch from the app grid.
- [ ] Linux VM (anything with FUSE): run the `.AppImage` directly.
      Confirm it boots without requiring additional deps.
- [ ] On launch, complete (or skip) the onboarding wizard: tmux/git probe
      passes, a real directory registers, default harness persists, first
      pane spawns.
- [ ] Register at least one project pointing at a real git repo.
- [ ] Spawn all three agent harnesses in succession (`⌘⇧C`, `⌘⇧X`, `⌘⇧O`).
      Confirm each pane streams output and the agent-state dots update.
- [ ] `⌘Q` to quit raum (leaving tmux running), reopen. All sessions
      should still be listed + attached; output replays correctly.
- [ ] Minimize a running harness, confirm it surfaces as a chip in the
      bottom dock, try each of the Working / Recent / Attention sort pills
      and restore the pane by clicking its chip.
- [ ] Run `⌘⇧F` global search. Confirm it queries every mounted pane and
      the *scroll-to-match* behaviour works on click.
- [ ] Trigger the updater check (relaunch app after the version is cut).
      The manifest at
      `https://github.com/andremonaco/raum/releases/latest/download/latest.json`
      should be fetched and (if a newer version exists) the update prompt
      should appear.

<!-- TODO(§14.7): Running this smoke test requires maintainer-provided
macOS + Linux VMs; it cannot be executed from this repository alone.
The checklist above *is* the deliverable — a maintainer cutting the real
release works through it and records results in the GitHub release notes
before publishing the draft. -->
