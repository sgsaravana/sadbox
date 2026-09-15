# sadbox worker base image — Spike B
# Debian trixie: tmux 3.5a (>= 3.4 gives synchronized-output passthrough,
# the flicker fix for Claude Code's TUI).
FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git tmux ncurses-term procps unzip ripgrep \
      openssh-client locales sudo less jq \
 && rm -rf /var/lib/apt/lists/* \
 && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

RUN useradd -m -s /bin/bash agent \
 && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent

USER agent
WORKDIR /home/agent

# Bun (official installer → ~/.bun/bin)
RUN curl -fsSL https://bun.com/install | bash
# Claude Code (official native installer → ~/.local/bin)
RUN curl -fsSL https://claude.ai/install.sh | bash

ENV PATH="/home/agent/.local/bin:/home/agent/.bun/bin:$PATH" \
    DISABLE_AUTOUPDATER=1

COPY --chown=agent:agent tmux.conf /home/agent/.tmux.conf

CMD ["sleep", "infinity"]
