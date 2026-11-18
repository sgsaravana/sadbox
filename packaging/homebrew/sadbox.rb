# Homebrew formula for sadbox. Publish in a tap repo (e.g. sgsaravana/homebrew-tap)
# as Formula/sadbox.rb, then: brew install sgsaravana/tap/sadbox
#
# `version`, both `url`s, and both `sha256`s are rewritten on each release by
# .github/workflows/release.yml (scripts/set-formula.sh) — copy this file to the
# tap after a release; do not edit those lines by hand.
class Sadbox < Formula
  desc "Supervisor for microVM AI-agent sandboxes"
  homepage "https://github.com/sgsaravana/sadbox"
  version "0.6.8"
  license "MIT"

  depends_on "container" if Hardware::CPU.arm?
  depends_on "vfkit" if Hardware::CPU.intel?
  depends_on :macos

  on_arm do
    url "https://github.com/sgsaravana/sadbox/releases/download/v0.6.8/sadbox-darwin-arm64"
    sha256 "34d207593e7e22d5e1d7e9b627951a76c68ace76c50db07c89d02e45ec125401"
  end
  on_intel do
    url "https://github.com/sgsaravana/sadbox/releases/download/v0.6.8/sadbox-darwin-x64"
    sha256 "d7064a3eef02c43706454c50a69d36f4ab552a6f58ff2d248919015cefbfed20"
  end

  def install
    bin.install Dir["sadbox-darwin-*"].first => "sadbox"
  end

  def caveats
    <<~EOS
      Before first use, provision the VM image:
        sadbox setup

      On an Intel Mac, `sadbox setup` also needs Docker (it builds the guest
      kernel and the VM disk):
        https://docs.docker.com/desktop/setup/install/mac-install/

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
