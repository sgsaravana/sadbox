#!/usr/bin/env bash
# Set the sadbox version wherever it is written down: src/config.ts (what
# `sadbox version` prints), package.json, and the README's examples of pinning
# the installer to a stable release (SADBOX_VERSION=v…). A beta example
# ("SADBOX_VERSION=vX.Y.Z-beta.1") is a placeholder and is left alone.
#
#   ./scripts/set-version.sh 0.3.0      (a leading "v" is fine: v0.3.0)
#
# release.yml runs this with the pushed tag, so the released binary always
# reports the tag it was built from.
set -euo pipefail

VERSION="${1:?usage: set-version.sh <version>}"
VERSION="${VERSION#v}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "not a version: $VERSION (expected e.g. 0.3.0 or 0.3.0-rc.1)" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

V="$VERSION" perl -pi -e 's/^(export const VERSION = ")[^"]*(";)/$1$ENV{V}$2/' src/config.ts
# only the first "version" key — the package's own
V="$VERSION" perl -pi -e 'if (!$done && s/^(\s*"version":\s*")[^"]*(")/$1$ENV{V}$2/) { $done = 1 }' package.json

grep -q "^export const VERSION = \"$VERSION\";" src/config.ts || { echo "src/config.ts: VERSION line not found" >&2; exit 1; }
grep -q "\"version\": \"$VERSION\"" package.json || { echo "package.json: version field not found" >&2; exit 1; }

# A pre-release build only stamps the binary: its README changes would be
# discarded (release.yml bumps main for stable tags only), and its example
# must not replace the stable one.
if [[ "$VERSION" == *-* ]]; then
  echo "version set to $VERSION (pre-release: README examples left alone)"
  exit 0
fi

# The installer examples, but only a stable one: a beta example like
# "SADBOX_VERSION=vX.Y.Z-beta.1" (or a concrete beta left in an older README)
# must not be rewritten to the stable version this script was called with.
V="$VERSION" perl -pi -e 's/(SADBOX_VERSION=)v\d+\.\d+\.\d+(?![0-9A-Za-z.\-])/$1v$ENV{V}/g' README.md

# Every stable example must now be this version. Placeholders ("vX.Y.Z") and
# pre-release examples ("v…-beta.1") are skipped: they are not this release's.
left="$(V="$VERSION" perl -ne 'while (/(SADBOX_VERSION=v\d+\.\d+\.\d+)(?![0-9A-Za-z.\-])/g) { print "$1\n" unless "$1" eq "SADBOX_VERSION=v$ENV{V}" }' README.md)"
if [ -n "$left" ]; then
  echo "README.md: SADBOX_VERSION example(s) not updated: $left" >&2
  exit 1
fi
echo "version set to $VERSION"
