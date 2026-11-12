#!/bin/sh
# sadbox installer — downloads the prebuilt binary for this platform.
#   curl -fsSL https://raw.githubusercontent.com/sgsaravana/sadbox/main/install.sh | sh
# Override: SADBOX_REPO=owner/repo  SADBOX_VERSION=v0.1.0  SADBOX_BIN_DIR=~/.local/bin
set -eu

REPO="${SADBOX_REPO:-sgsaravana/sadbox}"
VERSION="${SADBOX_VERSION:-latest}"
BIN_DIR="${SADBOX_BIN_DIR:-$HOME/.local/bin}"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os" in darwin) os=darwin ;; linux) os=linux ;; *) echo "unsupported OS: $os" >&2; exit 1 ;; esac
case "$arch" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo "unsupported arch: $arch" >&2; exit 1 ;; esac
asset="sadbox-${os}-${arch}"

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

echo "→ downloading ${asset} (${VERSION})"
mkdir -p "$BIN_DIR"
curl -fSL "$url" -o "$BIN_DIR/sadbox"
chmod +x "$BIN_DIR/sadbox"
echo "✓ installed sadbox to $BIN_DIR/sadbox"

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) echo "⚠  add $BIN_DIR to your PATH:  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc" ;;
esac

# The vfkit path (Intel, or Apple silicon older than macOS 26): what it needs.
check_vfkit() {
  missing=0
  if ! command -v vfkit >/dev/null 2>&1; then
    echo "· vfkit not found — 'sadbox setup' fetches a pinned build (or: brew install vfkit)"
  else
    echo "✓ vfkit"
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "✗ docker not found — it builds the guest kernel and the VM image:"
    echo "  https://docs.docker.com/desktop/setup/install/mac-install/ (or: brew install docker docker-buildx colima)"
    missing=1
  elif ! docker info >/dev/null 2>&1; then
    echo "✗ docker is installed but not running — start Docker Desktop (or: colima start)"
    missing=1
  elif ! docker buildx version >/dev/null 2>&1; then
    echo "✗ docker has no BuildKit (the buildx plugin) — with colima or Homebrew's docker CLI:"
    echo "  brew install docker-buildx   (the plugin folder it mentions goes in cliPluginsExtraDirs in ~/.docker/config.json)"
    missing=1
  else
    echo "✓ docker"
  fi
  for tool in git openssl curl; do
    if command -v "$tool" >/dev/null 2>&1; then echo "✓ $tool"; else echo "✗ $tool not found"; missing=1; fi
  done
  if [ "$missing" = 1 ]; then
    echo "· tools ship with the Xcode command line tools:  xcode-select --install"
  fi
}

if [ "$os" = "darwin" ]; then
  macos=$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)
  case "$macos" in ''|*[!0-9]*) macos=26 ;; esac
  echo
  if [ "$arch" != "arm64" ]; then
    echo "Intel Mac: projects run on Virtualization.framework through vfkit."
    check_vfkit
    echo
    [ "$missing" = 1 ] && echo "Fix the ✗ items above, then:"
    echo "Next:"
    echo "  sadbox setup             # build the guest kernel and VM image (a few minutes)"
    echo "  sadbox serve             # http://localhost:7070"
  elif [ "$macos" -lt 26 ]; then
    echo "macOS $macos: Apple's 'container' CLI needs macOS 26."
    echo "Projects can run on vfkit instead; prefix every command with SADBOX_DRIVER=vz."
    check_vfkit
    echo
    [ "$missing" = 1 ] && echo "Fix the ✗ items above, then:"
    echo "Next:"
    echo "  SADBOX_DRIVER=vz sadbox setup"
    echo "  SADBOX_DRIVER=vz sadbox serve"
  else
    if ! command -v container >/dev/null 2>&1; then
      echo "✗ Apple's 'container' CLI not found:  brew install container"
    else
      echo "✓ container"
    fi
    for tool in git openssl; do
      if ! command -v "$tool" >/dev/null 2>&1; then
        echo "✗ $tool not found (the Xcode command line tools:  xcode-select --install)"
      fi
    done
    echo
    echo "Next:"
    echo "  sadbox setup             # start container system + build the VM image"
    echo "  sadbox serve             # http://localhost:7070"
  fi
else
  # Linux: project VMs are Cloud Hypervisor microVMs on KVM; `sadbox setup`
  # fetches Cloud Hypervisor and its kernel and builds the VM disk with docker
  echo
  missing=0
  if [ ! -e /dev/kvm ]; then
    echo "✗ /dev/kvm is missing: this machine has no KVM (virtualization off in the firmware,"
    echo "  or a cloud VM without nested virtualization — see README: Supported platforms)"
    missing=1
  elif [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
    echo "✗ /dev/kvm is not usable by $(id -un):  sudo usermod -aG kvm $(id -un)   (then log in again)"
    missing=1
  else
    echo "✓ /dev/kvm"
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "✗ docker not found — it builds the VM image: https://docs.docker.com/engine/install/"
    missing=1
  elif ! docker info >/dev/null 2>&1; then
    echo "✗ docker is installed but not usable by $(id -un):  sudo usermod -aG docker $(id -un)   (then log in again)"
    missing=1
  elif ! docker buildx version >/dev/null 2>&1; then
    echo "✗ docker has no BuildKit (the buildx plugin) — install it:"
    echo "  docker-buildx-plugin (Docker's apt/dnf repository), or docker-buildx on Homebrew"
    missing=1
  else
    echo "✓ docker"
  fi
  for tool in git openssl curl; do
    if command -v "$tool" >/dev/null 2>&1; then echo "✓ $tool"; else echo "✗ $tool not found"; missing=1; fi
  done
  if command -v virtiofsd >/dev/null 2>&1 || [ -x /usr/libexec/virtiofsd ] || [ -x /usr/lib/qemu/virtiofsd ]; then
    echo "✓ virtiofsd (agent history is kept on this machine)"
  else
    echo "· virtiofsd not found (optional): without it agent history stays in each VM — install the virtiofsd package"
  fi
  [ "$arch" = "arm64" ] && echo "· arm64 Linux is built but not yet tested on a real KVM host"
  echo
  [ "$missing" = 1 ] && echo "Fix the ✗ items above, then:"
  [ "$missing" = 1 ] || echo "Next:"
  echo "  sadbox setup             # Cloud Hypervisor, its kernel, and the VM image (a few minutes)"
  echo "  sadbox serve             # http://localhost:7070"
  echo "  sadbox service install   # or: run it in the background, started at boot (systemd)"
fi
