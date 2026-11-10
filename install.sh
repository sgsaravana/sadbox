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

if [ "$os" = "darwin" ] && [ "$arch" != "arm64" ]; then
  echo
  echo "Note: this is an Intel Mac. Project microVMs need Apple's 'container' CLI,"
  echo "which only supports Apple silicon — 'brew install container' will not install here."
  echo "The UI/API run ('sadbox serve'), but creating projects is not available."
elif [ "$os" = "darwin" ]; then
  echo
  echo "Next:"
  echo "  brew install container   # if not already installed"
  echo "  sadbox setup             # start container system + build worker image"
  echo "  sadbox serve             # http://localhost:7070"
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
