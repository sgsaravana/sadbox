# Homebrew formula for sadbox. Publish in a tap repo (e.g. sgsaravana/homebrew-tap)
# as Formula/sadbox.rb, then: brew install sgsaravana/tap/sadbox
#
# `version`, both `url`s, and both `sha256`s are rewritten on each release by
# .github/workflows/release.yml (scripts/set-formula.sh) — copy this file to the
# tap after a release; do not edit those lines by hand.
class Sadbox < Formula
  desc "Supervisor for microVM AI-agent sandboxes"
  homepage "https://github.com/sgsaravana/sadbox"
  version "0.6.9"
  license "MIT"

  depends_on "container" if Hardware::CPU.arm?
  depends_on "vfkit" if Hardware::CPU.intel?
  depends_on :macos

  on_arm do
    url "https://github.com/sgsaravana/sadbox/releases/download/v0.6.9/sadbox-darwin-arm64"
    sha256 "a50c4d4e76a0740cac7a90627f3f3d1ab845f2c3eff194ee0a29d21933684a01"
  end
  on_intel do
    url "https://github.com/sgsaravana/sadbox/releases/download/v0.6.9/sadbox-darwin-x64"
    sha256 "f14fcc17260c5b3b1faa94caed1cc027ab05669cec85fe280a9740eb154ebdab"
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
