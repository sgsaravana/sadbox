#!/bin/sh
# sadbox installer — downloads the prebuilt binary for this platform.
#   curl -fsSL https://raw.githubusercontent.com/OWNER/sadbox/main/install.sh | sh
# Override: SADBOX_REPO=owner/repo  SADBOX_VERSION=v0.1.0  SADBOX_BIN_DIR=~/.local/bin
set -eu

REPO="${SADBOX_REPO:-OWNER/sadbox}"
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

if [ "$os" = "darwin" ]; then
  echo
  echo "Next:"
  echo "  brew install container   # if not already installed"
  echo "  sadbox setup             # start container system + build worker image"
  echo "  sadbox serve             # http://localhost:7070"
else
  echo
  echo "Note: on Linux, worker microVMs need the kvm driver (not yet shipped)."
  echo "The UI/API run, but 'create worker' is macOS-only for now."
fi
