#!/usr/bin/env bash
# Spike E: boot out/rootfs.ext4 under Cloud Hypervisor and run probe.ts
# against sadbox-agent over vsock. Then power it off, boot the same disk again
# (a stopped project's restart) and time that too.
#
#   ./build-rootfs.sh && ./run-ch.sh       → out/results-<machine>.json
#
# Needs Linux with a writable /dev/kvm, curl and bun.
set -euo pipefail
cd "$(dirname "$0")"
OUT=${OUT:-out}
CH_VERSION=v54.0
KERNEL_TAG=ch-release-v7.2.8-20261009
machine=$(uname -m)
case "$machine" in
  x86_64) ch_asset=cloud-hypervisor-static; kernel_asset=vmlinux-x86_64 ;;
  aarch64) ch_asset=cloud-hypervisor-static-aarch64; kernel_asset=Image-arm64 ;;
  *) echo "unsupported machine $machine" >&2; exit 1 ;;
esac
now() { date +%s%3N; }

[ -w /dev/kvm ] || { echo "/dev/kvm is missing or not writable" >&2; exit 1; }
[ -f "$OUT/rootfs.ext4" ] || { echo "no $OUT/rootfs.ext4 — run ./build-rootfs.sh first" >&2; exit 1; }

CH="$OUT/cloud-hypervisor-$CH_VERSION"
KERNEL="$OUT/$kernel_asset-$KERNEL_TAG"
[ -x "$CH" ] || { curl -fsSL -o "$CH" "https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/$CH_VERSION/$ch_asset"; chmod +x "$CH"; }
[ -f "$KERNEL" ] || curl -fsSL -o "$KERNEL" "https://github.com/cloud-hypervisor/linux/releases/download/$KERNEL_TAG/$kernel_asset"

# a short path: unix socket paths are limited to ~108 bytes
W=$(mktemp -d /tmp/sbx-e.XXXX)
ch_pid=""
cleanup() { [ -n "$ch_pid" ] && kill "$ch_pid" 2>/dev/null || true; }
trap cleanup EXIT

# a project's own disk: a copy-on-write clone of the base where the filesystem
# can (btrfs, xfs), a full copy otherwise
t=$(now)
cp --reflink=auto "$OUT/rootfs.ext4" "$W/disk.ext4"
clone_ms=$(( $(now) - t ))

boot() {
  rm -f "$W/ch.vsock" "$W/ch.vsock_1025" "$W/api.sock"
  "$CH" --api-socket "path=$W/api.sock" \
    --kernel "$KERNEL" \
    --cmdline "console=hvc0 root=/dev/vda rw init=/sbin/sadbox-agent sadbox.hostname=spike-e sadbox.announce=1025" \
    --disk "path=$W/disk.ext4,image_type=raw" \
    --cpus boot=2 --memory size=2048M \
    --vsock "cid=3,socket=$W/ch.vsock" \
    --console "file=$W/console-$1.log" --serial off \
    >"$W/ch-$1.log" 2>&1 &
  ch_pid=$!
}

# wait for CH to exit after the agent's poweroff; how long that took
await_exit() {
  local t; t=$(now)
  # an exited CH is a zombie until waited for, which `kill -0` still finds
  for _ in $(seq 1 200); do
    case "$(ps -o stat= -p "$ch_pid" 2>/dev/null)" in ""|Z*) wait "$ch_pid" 2>/dev/null || true; echo $(( $(now) - t )); return ;; esac
    sleep 0.05
  done
  kill "$ch_pid" 2>/dev/null || true; echo -1
}

status=0
echo '{}' >"$W/probe.json"; echo '{}' >"$W/restart.json" # if the agent never answers
launch=$(now); boot first
timeout -k 10 900 bun probe.ts --vsock "$W/ch.vsock" --wait 60000 --since "$launch" --vmm-pid "$ch_pid" --announce "$W/ch.vsock_1025" --poweroff --json "$W/probe.json" || status=$?
await_exit >"$W/shutdown"; shutdown_ms=$(cat "$W/shutdown")

launch=$(now); boot second
timeout -k 10 120 bun probe.ts --vsock "$W/ch.vsock" --wait 60000 --since "$launch" --vmm-pid "$ch_pid" --announce "$W/ch.vsock_1025" --ping-only --poweroff --json "$W/restart.json" || status=$?
await_exit >/dev/null

# the guest's own account of both boots, always: the agent logs to the console
echo "--- console (first boot), last 60 lines"; tail -60 "$W/console-first.log" 2>/dev/null || echo "(none)"
echo "--- console (restart), last 20 lines"; tail -20 "$W/console-second.log" 2>/dev/null || echo "(none)"
if [ "$status" -ne 0 ]; then
  [ "$status" -eq 124 ] && echo "--- the probe hit its time limit"
  echo "--- cloud-hypervisor (first boot)"; cat "$W/ch-first.log" 2>/dev/null || true
  echo "--- cloud-hypervisor (restart)"; cat "$W/ch-second.log" 2>/dev/null || true
fi

jq -n --slurpfile p "$W/probe.json" --slurpfile r "$W/restart.json" \
  --argjson build "$(cat "$OUT/build.json" 2>/dev/null || echo null)" \
  --arg machine "$machine" --arg ch "$CH_VERSION" --arg kernel "$KERNEL_TAG" \
  --argjson clone "$clone_ms" --argjson shutdown "$shutdown_ms" \
  --arg cpu "$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ //')" \
  '{machine: $machine, cpu: $cpu, cloudHypervisor: $ch, kernel: $kernel, build: $build,
    diskCloneMs: $clone, shutdownMs: $shutdown, restartBootMs: $r[0].timings.bootMs, restartAnnounceMs: $r[0].timings.announceMs,
    agent: $p[0].agent, timings: $p[0].timings, results: $p[0].results}' \
  | tee "$OUT/results-$machine.json"
exit "$status"
