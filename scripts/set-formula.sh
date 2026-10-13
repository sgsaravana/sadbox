#!/usr/bin/env bash
# Point the Homebrew formula (packaging/homebrew/sadbox.rb) at a release: its
# version, the two download URLs, and the checksums of the two macOS binaries.
#
#   ./scripts/set-formula.sh 0.3.0 <sha256 of sadbox-darwin-arm64> <sha256 of sadbox-darwin-x64>
#
# release.yml runs this after building, with the checksums of what it published.
set -euo pipefail

VERSION="${1:?usage: set-formula.sh <version> <arm64 sha256> <x64 sha256>}"
ARM_SHA="${2:?missing the arm64 sha256}"
X64_SHA="${3:?missing the x64 sha256}"
VERSION="${VERSION#v}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "not a version: $VERSION" >&2
  exit 1
fi
for sha in "$ARM_SHA" "$X64_SHA"; do
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo "not a sha256: $sha" >&2; exit 1; }
done

cd "$(dirname "$0")/.."
FORMULA=packaging/homebrew/sadbox.rb

V="$VERSION" ARM="$ARM_SHA" X64="$X64_SHA" perl -pi -e '
  s/^(\s*version ")[^"]*(")/$1$ENV{V}$2/;
  s{(/releases/download/)v[^/]+/}{$1v$ENV{V}/};
  $block = "ARM" if /^\s*on_arm do/;
  $block = "X64" if /^\s*on_intel do/;
  s/^(\s*sha256 ")[^"]*(")/$1$ENV{$block}$2/ if $block;
  $block = "" if /^\s*end\b/;
' "$FORMULA"

grep -q "^  version \"$VERSION\"" "$FORMULA" || { echo "$FORMULA: version line not found" >&2; exit 1; }
[ "$(grep -c "/releases/download/v$VERSION/sadbox-darwin-" "$FORMULA")" = 2 ] || { echo "$FORMULA: expected two download URLs" >&2; exit 1; }
grep -q "sha256 \"$ARM_SHA\"" "$FORMULA" || { echo "$FORMULA: arm64 sha256 not set" >&2; exit 1; }
grep -q "sha256 \"$X64_SHA\"" "$FORMULA" || { echo "$FORMULA: x64 sha256 not set" >&2; exit 1; }
echo "formula set to $VERSION"
