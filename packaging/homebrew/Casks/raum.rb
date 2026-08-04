cask "raum" do
  arch arm: "aarch64", intel: "x64"

  version "0.1.0"
  sha256 arm:   "REPLACE_WITH_ARM64_DMG_SHA256",
         intel: "REPLACE_WITH_X64_DMG_SHA256"

  url "https://github.com/andremonaco/raum/releases/download/v#{version}/raum_#{version}_#{arch}.dmg"
  name "raum"
  desc "Lightning-fast, recoverable terminals for AI agent harnesses"
  homepage "https://github.com/andremonaco/raum"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :big_sur
  depends_on formula: "tmux"

  app "raum.app"
  # `raum <dir>` opens a directory as a project from the terminal. The wrapper
  # (bundled at Contents/Resources/raum-cli) launches the GUI detached so the
  # shell returns immediately.
  binary "#{appdir}/raum.app/Contents/Resources/raum-cli", target: "raum"

  # Homebrew only unlinks the artifacts recorded in the *installed* cask's
  # receipt, and the `binary` stanza above only landed in 0.1.11. Receipts
  # written before that — and receipts that never got refreshed across an
  # upgrade; we have seen a 0.1.14 install still carrying a 0.1.3 receipt —
  # list only `app` + `zap`, so uninstalling the old version leaves
  # `bin/raum` behind. Linking the binary then finds an occupied target,
  # raises "It seems there is already a Binary at '<prefix>/bin/raum'", and
  # the whole upgrade rolls back: the user stays pinned to their installed
  # version until they delete the symlink by hand.
  #
  # Drop the orphan first (preflight runs before any artifact is installed,
  # whatever its position in this file). Only a symlink pointing into a
  # raum.app bundle is touched — exactly the link we, or a manual DMG
  # install, created — and the `binary` stanza recreates it immediately.
  preflight do
    stale_cli = Pathname("#{HOMEBREW_PREFIX}/bin/raum")
    if stale_cli.symlink? && stale_cli.readlink.to_s.end_with?("raum.app/Contents/Resources/raum-cli")
      begin
        FileUtils.rm stale_cli
      rescue Errno::EACCES, Errno::EPERM
        # Not writable without sudo. Fall through: linking raises the error
        # above, and `brew upgrade --cask --force raum` still gets through.
        opoo "Could not remove the stale #{stale_cli} symlink; retry with --force if linking fails."
      end
    end
  end

  zap trash: [
    "~/Library/Application Support/de.raum.desktop",
    "~/Library/Caches/de.raum.desktop",
    "~/Library/Preferences/de.raum.desktop.plist",
  ]
end
