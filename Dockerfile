# sadbox supervisor as a container, for a Linux host with KVM (docker-compose.yml).
#
# Project VMs are Cloud Hypervisor microVMs (src/driver/kvm), run inside this
# container on the host's /dev/kvm. Cloud Hypervisor and its guest kernel are
# baked in; the VM image is built by `sadbox setup` through the host's docker
# (the socket is mounted in). virtiofsd shares agent history into the VMs.
#
# Not for macOS hosts: a container there cannot reach Virtualization.framework,
# so run sadbox natively on a Mac (README: Deploying).
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY web ./web
COPY images ./images
COPY guest ./guest
RUN bun build --compile --minify src/index.ts --outfile /sadbox

FROM debian:trixie-slim
# keep in step with src/driver/kvm/vmm.ts (checked by its tests)
ARG CH_VERSION=v54.0
ARG KERNEL_TAG=ch-release-v7.2.8-20261009
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssl virtiofsd docker-cli docker-buildx \
 && rm -rf /var/lib/apt/lists/* \
 # project folders are mounted in from the host, owned by someone else
 && git config --system --add safe.directory '*'
RUN set -eu; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) ch=cloud-hypervisor-static; kernel=vmlinux-x86_64 ;; \
      arm64) ch=cloud-hypervisor-static-aarch64; kernel=Image-arm64 ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/sadbox; \
    curl -fsSL -o /opt/sadbox/cloud-hypervisor "https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/${CH_VERSION}/${ch}"; \
    curl -fsSL -o /opt/sadbox/kernel "https://github.com/cloud-hypervisor/linux/releases/download/${KERNEL_TAG}/${kernel}"; \
    chmod 0755 /opt/sadbox/cloud-hypervisor
COPY --from=build /sadbox /usr/local/bin/sadbox

ENV SADBOX_DATA=/data \
    SADBOX_PORT=7070 \
    SADBOX_DRIVER=kvm \
    SADBOX_CH_BIN=/opt/sadbox/cloud-hypervisor \
    SADBOX_KVM_KERNEL=/opt/sadbox/kernel
VOLUME /data
EXPOSE 7070

CMD ["/usr/local/bin/sadbox", "serve"]
