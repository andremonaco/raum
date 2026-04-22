# Homebrew distribution

raum is distributed via a Homebrew tap at `andremonaco/homebrew-raum`.
Users install with a single command:

```sh
brew install --cask andremonaco/raum/raum
```

The three-segment name (`<user>/<tap>/<cask>`) triggers an implicit
`brew tap`, so no separate tap step is needed. `brew upgrade raum` works
identically afterwards.

## Contents

- `Casks/raum.rb` — canonical Cask definition. The release workflow
  copies this file into the `andremonaco/homebrew-raum` repo, patches in
  the new version + SHA256s for the macOS DMGs, and opens a PR.

## One-time setup (maintainer)

1. Create a public repo named **exactly** `homebrew-raum` under your
   GitHub account (`andremonaco/homebrew-raum`). The `homebrew-` prefix
   is mandatory; Homebrew strips it when resolving tap names.
2. Commit the current `Casks/raum.rb` (copy from this directory) to the
   tap repo's default branch.
3. Create a fine-grained PAT with `contents: write` + `pull-requests: write`
   scoped to that single repo. Store it as the
   `HOMEBREW_TAP_TOKEN` secret on `andremonaco/raum`.
4. Subsequent releases run the `bump-homebrew` job in
   `.github/workflows/release.yml`, which opens a PR bumping the version
   + SHA256s. Review and merge.

## Future: core Homebrew cask

Once raum is past 1.0 and has stable releases, submit `Casks/raum.rb`
to `Homebrew/homebrew-cask` so the install command collapses to:

```sh
brew install --cask raum
```
