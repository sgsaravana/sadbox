# Homebrew formula for sadbox. Publish in a tap repo (e.g. sgsaravana/homebrew-tap)
# as Formula/sadbox.rb, then: brew install sgsaravana/tap/sadbox
#
# `version`, both `url`s, and both `sha256`s are rewritten on each release by
# .github/workflows/release.yml (scripts/set-formula.sh) — copy this file to the
# tap after a release; do not edit those lines by hand.
class Sadbox < Formula
  desc "Supervisor for microVM AI-agent sandboxes"
  homepage "https://github.com/sgsaravana/sadbox"
  version "0.3.1"
  license "MIT"

  depends_on "container"
  depends_on :macos

  on_arm do
    url "https://github.com/sgsaravana/sadbox/releases/download/v0.3.1/sadbox-darwin-arm64"
    sha256 "84d694a0e9d56da98d67f2bd61a1c0b5ccbbf40791d51cd6ee60e46415e310a6"
  end
  on_intel do
    url "https://github.com/sgsaravana/sadbox/releases/download/v0.3.1/sadbox-darwin-x64"
    sha256 "601d3ec27e2ed8d64905c21919061dd966ac4448d7639165b2dc1e8dcc3d412c"
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
