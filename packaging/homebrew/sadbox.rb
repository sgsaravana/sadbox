# Homebrew formula for sadbox. Publish in a tap repo (e.g. sgsaravana/homebrew-tap)
# as Formula/sadbox.rb, then: brew install sgsaravana/tap/sadbox
#
# `version`, both `url`s, and both `sha256`s are rewritten on each release by
# .github/workflows/release.yml (scripts/set-formula.sh) — copy this file to the
# tap after a release; do not edit those lines by hand.
class Sadbox < Formula
  desc "Supervisor for microVM AI-agent sandboxes"
  homepage "https://github.com/sgsaravana/sadbox"
  version "0.3.0"
  license "MIT"

  depends_on "container"
  depends_on :macos

  on_arm do
    url "https://github.com/sgsaravana/sadbox/releases/download/v0.3.0/sadbox-darwin-arm64"
    sha256 "9d7794802f3fe6ea1bf3460f8589b67c192e1cdb24da0c689a95f42eb0f8bf31"
  end
  on_intel do
    url "https://github.com/sgsaravana/sadbox/releases/download/v0.3.0/sadbox-darwin-x64"
    sha256 "edfb0e345ba28578dbadfe3f563d1637e60b312fd1521d14fe5b3d146a6926c0"
  end

  def install
    bin.install Dir["sadbox-darwin-*"].first => "sadbox"
  end

  def caveats
    <<~EOS
      Before first use, provision the worker image and container system:
        sadbox setup

      To run at login as a background service:
        brew services start sadbox
      Then open http://localhost:7070
    EOS
  end

  service do
    run [opt_bin/"sadbox", "serve"]
    keep_alive true
    log_path var/"log/sadbox.log"
    error_log_path var/"log/sadbox.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/sadbox version")
  end
end
