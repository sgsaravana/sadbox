# A sadbox image as a disk for the Linux driver (src/driver/kvm): the image's
# files on ext4, with sadbox-agent (guest/agent) as the VM's init. Proven in
# spikes/e-cloud-hypervisor. Built by src/driver/kvm/images.ts, with BuildKit
# writing the result to a folder:
#
#   docker build --build-arg BASE=sadbox-base:latest -o type=local,dest=OUT .
#     → OUT/rootfs.ext4, OUT/user (the image USER's uid:gid)
#
# The build context holds this file, image.json (the image's Env / User /
# WorkingDir, which a disk would otherwise lose) and agent/ (the agent's
# source). Nothing runs as root on the host, and the host needs no Go.
ARG BASE=sadbox-base:latest

FROM golang:1.26-trixie AS agent
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/*.go ./
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /sadbox-agent .

FROM ${BASE} AS base

FROM debian:trixie-slim AS disk
RUN apt-get update && apt-get install -y --no-install-recommends e2fsprogs && rm -rf /var/lib/apt/lists/*
COPY --from=agent /sadbox-agent /sadbox-agent
COPY image.json /image.json
# The image's own filesystem, bind-mounted as it is (owners, setuid bits and
# links intact; a COPY would not promise that), with the agent and the image's
# settings added in a scratch layer that the mkfs sees and the image never does.
# Sized to what is there plus a quarter: each project's copy is grown, and the
# agent grows the filesystem to fit at boot.
RUN --mount=type=bind,from=base,target=/rootfs,rw \
    install -m 0755 /sadbox-agent /rootfs/sbin/sadbox-agent \
 && mkdir -p /rootfs/etc/sadbox && install -m 0644 /image.json /rootfs/etc/sadbox/image.json \
 && user=$(sed -n 's/.*"User": *"\([^"]*\)".*/\1/p' /image.json | cut -d: -f1) \
 && awk -F: -v u="${user:-root}" '$1 == u || $3 == u { print $3 ":" $4; exit }' /rootfs/etc/passwd > /user \
 && used=$(du -sm /rootfs | cut -f1) \
 && mkfs.ext4 -q -F -L sadbox-root -d /rootfs /rootfs.ext4 "$((used + used / 4 + 256))M"

FROM scratch
COPY --from=disk /rootfs.ext4 /user /
