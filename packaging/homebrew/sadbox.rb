# Homebrew formula for sadbox. Publish in a tap repo (e.g. sgsaravana/homebrew-tap)
# as Formula/sadbox.rb, then: brew install sgsaravana/tap/sadbox
#
# `version`, both `url`s, and both `sha256`s are rewritten on each release by
# .github/workflows/release.yml (scripts/set-formula.sh) — copy this file to the
# tap after a release; do not edit those lines by hand.
class Sadbox < Formula
  desc "Supervisor for microVM AI-agent sandboxes"
  homepage "https://github.com/sgsaravana/sadbox"
  version "0.3.2"
  license "MIT"

  depends_on "container"
  depends_on :macos

  on_arm do
    url "https://github.com/sgsaravana/sadbox/releases/download/v0.3.2/sadbox-darwin-arm64"
    sha256 "91f8e5897d3b306e0905194745085e41c4c9b00d5bb4800da6691adb1267e651"
  end
  on_intel do
    url "https://github.com/sgsaravana/sadbox/releases/download/v0.3.2/sadbox-darwin-x64"
    sha256 "c581e38753990c1db61362765349f004be17bbc65d799f09a0af21f97e7a40ca"
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
