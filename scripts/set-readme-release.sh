#!/usr/bin/env bash
# Set README.md's "Latest release" line, between the LATEST_RELEASE markers:
#
#   ./scripts/set-readme-release.sh v0.5.0 <release-url> [name] [date]
#
# release.yml's bump-main runs this for a tag-created release (GitHub does not
# chain the `release: published` event that job creates), and
# update-readme-release.yml runs it for one published from the UI or a manual
# re-sync. Both write the same line, so a release ends up the same whichever
# way it was cut.
set -euo pipefail

TAG="${1:?usage: set-readme-release.sh <tag> <release-url> [name] [date]}"
URL="${2:?missing the release URL}"
NAME="${3:-}"
DATE="${4:-}"

cd "$(dirname "$0")/.."

if ! grep -q '<!-- LATEST_RELEASE:START -->' README.md || ! grep -q '<!-- LATEST_RELEASE:END -->' README.md; then
  echo "README.md: LATEST_RELEASE markers not found" >&2
  exit 1
fi

[ -n "$DATE" ] || DATE="$(date -u +%F)"

TAG="$TAG" URL="$URL" NAME="$NAME" DATE="$DATE" perl -0777 -pi -e '
  my $tag = $ENV{TAG};
  my $label = ($ENV{NAME} eq "" || $ENV{NAME} eq $tag) ? $tag : "$tag — $ENV{NAME}";
  my $block = "**Latest release: [$label]($ENV{URL})**"
            . ($ENV{DATE} ne "" ? " · published $ENV{DATE}" : "")
            . " · [release notes →]($ENV{URL})";
  s{<!-- LATEST_RELEASE:START -->.*?<!-- LATEST_RELEASE:END -->}{<!-- LATEST_RELEASE:START -->\n$block\n<!-- LATEST_RELEASE:END -->}s;
' README.md

grep -qF "]($URL)**" README.md || { echo "README.md: latest-release line not written" >&2; exit 1; }
grep -qF "published $DATE" README.md || { echo "README.md: latest-release date not written" >&2; exit 1; }
echo "latest release set to $TAG"
