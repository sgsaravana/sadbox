#!/usr/bin/env bash
# Set the sadbox version wherever it is written down: src/config.ts (what
# `sadbox version` prints), package.json, and the README's examples of pinning
# the installer to a release (SADBOX_VERSION=v…).
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
V="$VERSION" perl -pi -e 's/(SADBOX_VERSION=)v[0-9][0-9A-Za-z.\-]*/$1v$ENV{V}/g' README.md

grep -q "^export const VERSION = \"$VERSION\";" src/config.ts || { echo "src/config.ts: VERSION line not found" >&2; exit 1; }
grep -q "\"version\": \"$VERSION\"" package.json || { echo "package.json: version field not found" >&2; exit 1; }
if grep -q "SADBOX_VERSION=v" README.md && grep "SADBOX_VERSION=v" README.md | grep -qv "SADBOX_VERSION=v$VERSION\b"; then
  echo "README.md: a SADBOX_VERSION example was not updated" >&2; exit 1
fi
echo "version set to $VERSION"
