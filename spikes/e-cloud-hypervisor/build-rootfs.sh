#!/usr/bin/env bash
# Spike E: the sadbox base image as a disk Cloud Hypervisor can boot.
#
# Builds images/base with docker, exports its files into an ext4 image, and
# adds sadbox-agent as /sbin/sadbox-agent (the VM's init). `docker export`
# keeps files but not the image's ENV / USER / WORKDIR, so those are written to
# /etc/sadbox/image.json for the agent. Needs Linux, docker, go, jq, e2fsprogs
# and sudo (to keep the files' owners and setuid bits, e.g. sudo's).
#
#   ./build-rootfs.sh          → out/rootfs.ext4, out/sadbox-agent, out/build.json
set -euo pipefail
cd "$(dirname "$0")"
OUT=${OUT:-out}
mkdir -p "$OUT"
case "$(uname -m)" in
  x86_64) goarch=amd64 ;;
  aarch64) goarch=arm64 ;;
  *) echo "unsupported machine $(uname -m)" >&2; exit 1 ;;
esac
now() { date +%s%3N; }

(cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=$goarch go build -trimpath -ldflags "-s -w" -o "../$OUT/sadbox-agent" .)

t=$(now)
docker build -q -t sadbox-base:spike-e ../../images/base >/dev/null
build_ms=$(( $(now) - t ))

t=$(now)
root="$OUT/rootfs"
sudo rm -rf "$root"
mkdir -p "$root"
cid=$(docker create sadbox-base:spike-e)
docker export "$cid" | sudo tar -x -p --numeric-owner -C "$root"
docker rm "$cid" >/dev/null
sudo mkdir -p "$root/etc/sadbox"
docker image inspect sadbox-base:spike-e | jq '.[0].Config | {Env, User, WorkingDir}' | sudo tee "$root/etc/sadbox/image.json" >/dev/null
sudo install -m 0755 "$OUT/sadbox-agent" "$root/sbin/sadbox-agent"

used_mb=$(sudo du -sm "$root" | cut -f1)
size_mb=$(( used_mb + used_mb / 4 + 1024 )) # room to work in
rm -f "$OUT/rootfs.ext4"
truncate -s "${size_mb}M" "$OUT/rootfs.ext4"
sudo mkfs.ext4 -q -F -L sadbox-root -d "$root" "$OUT/rootfs.ext4"
sudo chown "$(id -u):$(id -g)" "$OUT/rootfs.ext4"
sudo rm -rf "$root"
rootfs_ms=$(( $(now) - t ))

printf '{"imageBuildMs":%d,"rootfsMs":%d,"rootfsUsedMB":%d,"rootfsSizeMB":%d}\n' \
  "$build_ms" "$rootfs_ms" "$used_mb" "$size_mb" | tee "$OUT/build.json"
