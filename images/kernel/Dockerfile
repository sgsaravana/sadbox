# The vz driver's guest kernel and initramfs (src/driver/vz), built by
# `sadbox setup` for the host's architecture:
#
#   docker build -o type=local,dest=~/.sadbox/vz/bin images/kernel
#     → vmlinuz, initrd.img
#
# Virtualization.framework boots this directly (an uncompressed Image on Apple
# silicon, a bzImage on Intel). Debian's kernel is used rather than Cloud
# Hypervisor's: CH's build is made for CH's device model and does not start
# under VZ (tested on arm64, 2026-11-11 — VZ refuses it before the guest runs).
#
# The initramfs carries the virtio and vsock modules the guest needs: the root
# disk on virtio-blk, virtiofs mounts, the console, and sadbox-agent's vsock
# socket. Without them the agent exits with "open /dev/vsock: no such file".
ARG BASE=debian:trixie-slim

FROM ${BASE} AS kernel
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      arm64) arch=arm64 ;; \
      amd64) arch=amd64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && apt-get update \
 && apt-get install -y --no-install-recommends "linux-image-$arch" initramfs-tools \
 && rm -rf /var/lib/apt/lists/* \
 && printf 'virtio_pci\nvirtio_blk\nvirtio_console\nvirtio_fs\nvsock\nvmw_vsock_virtio_transport\next4\n' >> /etc/initramfs-tools/modules \
 && update-initramfs -c -k all \
 && mkdir -p /out \
 && cp /boot/vmlinuz-* /out/vmlinuz \
 && cp /boot/initrd.img-* /out/initrd.img

FROM scratch
COPY --from=kernel /out/vmlinuz /vmlinuz
COPY --from=kernel /out/initrd.img /initrd.img
