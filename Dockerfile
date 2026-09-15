# sadbox supervisor image.
#
# Reality check per docs/research/02: this image is only fully functional on a
# LINUX host with /dev/kvm once the kvm (Cloud Hypervisor) driver lands — a
# containerized supervisor on a macOS host cannot reach Virtualization.framework
# and cannot spawn microVMs (no nested virt on M1/M2 either). On a macOS
# machine (e.g. a Mac mini server), run the supervisor natively with Bun
# instead — see "Deploying" in README.md.
FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY web ./web
COPY images ./images

ENV SADBOX_DATA=/data \
    SADBOX_PORT=7070 \
    SADBOX_HOST=0.0.0.0
VOLUME /data
EXPOSE 7070

CMD ["bun", "run", "src/index.ts"]
