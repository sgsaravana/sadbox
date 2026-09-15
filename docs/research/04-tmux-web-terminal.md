# 04 — Browser terminals attached to tmux inside microVM workers

Status: research, September 2026. All versions/claims verified against upstream repos this month.

## Context

sadbox (the supervisor) deploys microVM "workers" (Linux guests) on a macOS 26 / M1 Max host
via Apple Containerization (`container` CLI 1.4.1, Sep 2026) now, Firecracker-class backends
later. Each worker runs tmux with Claude Code inside. Requirement, verbatim: *"I want to run
tmux in the vm, and have a web view into the tmux instance. I want to be able to open a VM's
tmux instance in a separate tab/browser as I would be working with multiple vms."*

So the unit of attachment is **a tmux client per browser tab**, the tmux *server* lives inside
the VM (and therefore survives supervisor restarts), and the supervisor's job is to be a dumb,
reliable byte pipe with resize + auth + reconnect handling.

## Browser layer

**Use xterm.js. There is no credible alternative for TUI fidelity.** It is what VS Code,
Hyper, Theia, ttyd, Coder, and code-server all use.

- Current version: **@xterm/xterm 6.0.0** (released 2025-12-22; previous stable 5.5.0 was
  Apr 2024). 6.0 removed the legacy canvas renderer, added ESM builds, shadow-DOM support,
  and — critically for us — **synchronized output (DEC private mode 2026)**.
- Why mode 2026 matters here specifically: Claude Code's streaming renderer is a known
  flicker source inside tmux (anthropics/claude-code #37283, #9935). tmux ≥3.4 passes
  synchronized-output through, and xterm.js 6.0 honors it, so the chain
  Claude Code → tmux → xterm.js 6.0 is the first stack where the flicker fix works
  end-to-end. Pin xterm.js ≥6.0, tmux ≥3.4 (ship 3.5a in the guest image).
- Addons to load (all under the `@xterm/` scope since 5.4):
  - `@xterm/addon-webgl` — GPU renderer; falls back to DOM renderer automatically on
    context loss. Use it; Claude Code repaints large regions constantly.
  - `@xterm/addon-fit` — container-driven sizing; call `fit()` on `ResizeObserver` and
    send the resulting cols/rows to the server.
  - `@xterm/addon-unicode-graphemes` (or `addon-unicode11`) — Claude Code output is heavy
    on emoji/box-drawing/spinners; grapheme clustering keeps widths correct.
  - `@xterm/addon-clipboard` — OSC 52 clipboard. With `set -g set-clipboard on` in tmux,
    copy-mode yanks inside the VM land on the user's real clipboard. This is the single
    biggest quality-of-life win for a web terminal; do it on day one.
  - Skip `@xterm/addon-attach` — it assumes raw-bytes-only WS with no control channel;
    we need a framed protocol (below).

TUI fidelity checklist for Claude Code under tmux:

| Need | How |
|---|---|
| truecolor | Spawn PTY env with `TERM=xterm-256color`, `COLORTERM=truecolor`; in guest tmux.conf: `set -g default-terminal "tmux-256color"` + `set -as terminal-features ',xterm-256color:RGB'`. Note claude-code #59867: Claude Code may still downsample when it detects tmux — track that issue; nothing to do on our side beyond correct env. |
| mouse | xterm.js emits SGR mouse reporting natively; `set -g mouse on` in the guest gives wheel-scroll → tmux copy-mode, pane clicking. |
| resize | fit-addon cols/rows → WS control msg → `resize()` on the supervisor PTY → SIGWINCH propagates through exec/ssh → tmux reflows. Must be wired at every hop or Claude Code renders at the wrong width forever. |
| scrollback | tmux owns scrollback (`history-limit 50000` in guest). Set xterm.js `scrollback: 0`-ish (e.g. 1000) and rely on tmux copy-mode; two competing scrollbacks is the classic tmux-in-browser confusion. xterm.js "alternateScroll" converts wheel to arrows when apps are on the alt screen. |
| paste | Bracketed paste flows through untouched; large pastes need WS backpressure (below). |

## Transport options compared

The question is what carries bytes between the supervisor process (macOS host) and the tmux
server (VM guest). Three families:

### (a) Supervisor spawns a PTY running `ssh worker -t -- tmux new -A -s main`

Supervisor holds a local PTY (node-pty / Bun.Terminal / creack-pty) whose child is an ssh
client; bridge PTY⇄WS.

- **Latency**: one extra hop (host TCP → guest sshd), negligible on-box (<1 ms).
- **Resize**: free — resize the local PTY; ssh sends `window-change`; perfect propagation.
- **Auth**: supervisor-injected keypair per worker; sshd + key provisioning must be baked
  into every guest image. Real cost.
- **Reconnect**: respawn ssh; tmux `-A` reattaches. Clean.
- **Portability**: works on any backend that gives the guest an IP (Apple `container` does;
  Firecracker needs tap networking configured). But it drags sshd, host keys, and known_hosts
  noise into every image for no other reason.

### (b) In-guest terminal daemon (ttyd), supervisor reverse-proxies WS

Run `ttyd -W tmux new -A -s main` inside each VM; supervisor proxies
`/workers/:id/terminal/ws` → `guest-ip:7681/ws`.

- **Maturity 2026**: ttyd last *release* is 1.7.7 (Mar 2024) but the repo has commits
  through Aug 2026 — maintenance mode, not abandoned. wetty is actively released
  (v3.2.1, Sep 2026) but is ssh-centric Node, wrong shape for in-guest use. GoTTY is dead;
  its living fork is tty2web.
- **ttyd's WS protocol** (worth stealing even if we don't run ttyd): binary frames with a
  1-byte command prefix. Client→server: `'0'` INPUT, `'1'` RESIZE (JSON
  `{"columns":N,"rows":N}`), `'2'` PAUSE, `'3'` RESUME, and an initial `{...}` JSON message
  carrying `AuthToken` + initial size. Server→client: `'0'` OUTPUT, `'1'` SET_WINDOW_TITLE,
  `'2'` SET_PREFERENCES. Includes flow control and an Origin check.
- **Latency**: same as (a).
- **Auth**: two layers to keep coherent (supervisor auth + per-guest ttyd token). The proxy
  must forward the upgrade, handle guest restarts, and translate close codes.
- **Reconnect**: browser reconnects through proxy; ttyd respawns the command; `-A` handles it.
- **Portability**: needs guest networking to the daemon (fine on Apple backend; on
  Firecracker either tap or a vsock↔TCP forwarder). Adds a daemon + its libwebsockets dep
  to every image and a second protocol/version surface to manage.

### (c) Backend exec over vsock, bridged to WS by the supervisor

Apple Containerization boots every VM with **vminitd**, a Swift init that exposes a gRPC API
over **vsock (port 1024)** for launching processes with stdio relayed over dedicated vsock
ports. `container exec -it <worker> tmux new -A -s main` is exactly this: a real guest-side
PTY, interactive stdio, TTY semantics — no sshd, no daemon, nothing extra in the image.
Practical shape: supervisor spawns a *local* PTY whose child is the `container exec -it ...`
CLI, and bridges that PTY⇄WS. Resizing the local PTY SIGWINCHes the CLI, which relays the
resize over gRPC to vminitd.

Firecracker has no exec facility; its vsock appears on the host as a Unix socket with a
`CONNECT <port>\n` handshake for host-initiated connections. So on that backend, (c) means
a tiny in-guest agent listening on a vsock port that spawns a PTY running
`tmux new -A -s main` and speaks length-prefixed frames — ~200 lines of Go/Rust, or reuse
Coder's agent ideas.

- **Latency**: best (vsock, no TCP/ssh stack).
- **Resize**: via local-PTY SIGWINCH (Apple) or an explicit frame (own agent). Verify the
  `container` CLI's resize relay early — it's the one unproven link.
- **Auth**: none inside the trust boundary; vsock is host-only by construction. All auth
  collapses into the supervisor's own WS auth. Simplest correct model.
- **Reconnect**: respawn exec; `-A` reattaches.
- **Portability**: the supervisor-side abstraction is just "an argv that attaches to this
  worker's tmux" — `["container","exec","-it",id,...]` today, `["ssh",...]` or a vsock
  dialer later. The PTY⇄WS bridge never changes.

**Verdict**: (c) wins now (zero guest additions, best auth story, backend CLI does the vsock
work), with (a) as the portable fallback shape and (b)'s *protocol* adopted as our wire
format. Running actual ttyd is the fallback only if supervisor-side PTY code proves painful.

## tmux integration details

- **Attach command**: always `tmux new-session -A -s main` — atomically attach-or-create,
  which kills the session-not-yet-created race. Never bare `tmux attach`.
- **Plain attach vs control mode (`-CC`)**: control mode turns tmux into a structured
  protocol (iTerm2's integration) where the *client* renders windows/panes natively. For a
  web client this is overkill: you would reimplement iTerm2's layout engine in the browser,
  and you'd still need a full terminal emulator per pane. Plain attach gives 100% fidelity
  because xterm.js simply renders tmux's own UI (status bar, panes, copy-mode). Revisit
  `-CC` only if we ever want "each tmux window as a browser tab" as a native feature.
- **Multiple viewers**: each tab is an independent tmux client on the same session. Default
  tmux sizes the session to the *smallest* client; set `set -g window-size latest`
  (tmux ≥3.1) in the guest so the most recently active tab wins and small stale tabs don't
  shrink everyone. Claude Code redraws fine on size change.
- **Detach on disconnect**: when a tab's WS closes, the supervisor kills that connection's
  exec/PTY child → that tmux client detaches → session and Claude Code keep running. This is
  the whole point of tmux-in-the-VM.
- **Supervisor restarts**: tmux server + Claude Code live entirely in the guest; supervisor
  restart only drops WS bridges. Tabs auto-reconnect and `-A` reattaches. No supervisor-side
  session state to persist beyond worker inventory.
- **VM restart**: kills the tmux server. Guest boot should start the session detached
  (`tmux new -d -s main 'claude'` from the guest init / vminitd-launched process) so a
  reattaching tab finds Claude Code already running rather than an empty shell.
- **Guest tmux.conf baseline**:
  `default-terminal "tmux-256color"`, `terminal-features ',xterm-256color:RGB'`,
  `set -g mouse on`, `set -g set-clipboard on`, `set -g history-limit 50000`,
  `set -g window-size latest`, `set -g focus-events on`, `set -sg escape-time 10`.

## Multi-tab & auth

- **URLs**: page at `/workers/:id/terminal` (full-viewport terminal, minimal chrome), WS at
  `/workers/:id/terminal/ws`. Every tab opens its own WS; each WS = one supervisor PTY = one
  tmux client. This is the natural model — no fan-out/multiplexing needed, tmux *is* the
  multiplexer. Cost per tab is one PTY + one exec process on the host: irrelevant at
  “a handful of VMs” scale.
- **Auth for standalone tabs**: supervisor is same-origin for its own pages, and browsers
  send cookies on same-origin WS upgrades. So: **session cookie (HttpOnly, SameSite=Lax) +
  Origin/Host check on upgrade** (exactly what ttyd's `check_host_origin` does). Do *not*
  put long-lived tokens in the URL (history, logs, screenshots). If the UI ever becomes a
  separate origin from the supervisor API, switch to the **ticket endpoint** pattern:
  `POST /workers/:id/terminal/ticket` → single-use ~10 s token → passed as query param on
  the WS URL — short-lived and single-use makes URL exposure moot. Coder and most
  production web terminals use this shape.
- **VM restart / exec death**: PTY child exits → supervisor sends a WS close (or an `exit`
  control frame with reason) → client greys the screen with a "worker restarting —
  reconnecting…" overlay and retries with exponential backoff + jitter; on success it sends
  the init frame (size) and the server re-runs the attach argv, where `-A` recreates the
  session. Client keeps the last rendered frame visible while disconnected instead of
  clearing (Coder's web terminal does this; it feels dramatically better).
- **Wire format** (ttyd-flavored, binary frames): client→server `i`+bytes (input),
  `r`+JSON `{cols,rows}` (resize), `p`/`R` (pause/resume flow control); server→client
  `o`+bytes (output), `t`+title, `e`+JSON exit/error. First client frame after open: JSON
  init `{ticket?, cols, rows}`. Flow control matters: Claude Code can emit multi-MB bursts;
  pause reads from the PTY when WS bufferedAmount is high or the client says pause.

## Stack notes (Bun vs Go server pieces)

**Bun** (current: 1.4.2, Sep 2026)
- **`Bun.Terminal` is native PTY support, shipped in Bun v1.3.5 (Dec 2025)** — this removes
  the historical blocker (node-pty's native module was unreliable under Bun).
  `Bun.spawn(argv, { terminal: { cols, rows, data(term, chunk){...} } })`,
  `proc.terminal.write(chunk)`, `proc.terminal.resize(cols, rows)`, `await using` cleanup.
  POSIX-only — fine, the supervisor runs on macOS.
- Bun.serve has first-class WebSocket handlers with backpressure signals (`ws.send` return
  value / `drain` callback) — pairs naturally with the pause/resume protocol.
- node-pty 1.1.0 remains the Node fallback if we ever run under Node.

**Go**
- PTY: `creack/pty` (`pty.Start(exec.Command(...))`, `pty.Setsize`) — boring and solid.
- WS: `coder/websocket` (the maintained continuation of nhooyr.io/websocket; context-aware,
  good close semantics) or `gorilla/websocket` (maintained again under the gorilla org).
- Strong prior art in Go: **Coder's reconnecting-PTY** (browser ⇄ WS ⇄ coderd ⇄ agent ⇄
  shell, reconnection tokens so a refresh resumes the same server-side PTY), and
  **tty2web/gotty's `webtty` package** (clean PTY⇄WS bridging with a framed protocol).

**References to read before implementing**: ttyd's `src/protocol.c` + html client (protocol +
flow control), Coder `agent/reconnectingpty` (reconnect semantics), VS Code / code-server
(xterm.js integration patterns, renderer choices; their remote terminal protocol itself is
more machinery than we need — tmux already gives us persistence).

Either stack works. This component should not drive the stack choice; Bun.Terminal's arrival
in 1.3.5 removed Go's former advantage here.

## Recommendation

**Primary architecture (per browser tab):**

```
browser tab (/workers/:id/terminal)
  xterm.js 6.0 + webgl/fit/unicode-graphemes/clipboard addons
    ⇅ WebSocket (binary, ttyd-style framed protocol; cookie auth + Origin check,
       ticket endpoint if UI origin ever splits)
supervisor (Bun.Terminal or creack/pty): one PTY per WS connection
    child argv from backend adapter:
      Apple backend today:  container exec -it <worker> tmux new-session -A -s main
      Firecracker later:    vsock agent dial (or ssh -t) → tmux new-session -A -s main
    ⇅ (inside `container exec`: gRPC to vminitd over vsock; guest-side PTY)
tmux server inside the VM  ←  session "main" running Claude Code
```

Supervisor code is backend-agnostic: the only per-backend piece is "give me an argv (or a
stream) that attaches to this worker's tmux." tmux owns persistence, scrollback, and
multi-viewer semantics; the supervisor owns auth, resize plumbing, flow control, reconnect.

**Fallback**: ttyd 1.7.7 baked into the guest image running `ttyd -W tmux new -A -s main`,
supervisor reverse-proxying WS to the guest IP. Choose it only if `container exec` proves
unsuitable as a PTY child (e.g. broken resize relay) — it costs a guest daemon, dual-layer
auth, and proxy plumbing, but its client/protocol are battle-tested.

**Explicit non-choices**: tmux `-CC` control mode (browser-side layout engine for no fidelity
gain); `@xterm/addon-attach` (no control channel); per-worker sshd on the Apple backend
(vsock exec makes it dead weight); WebRTC data channels (nothing here needs P2P).

## Open questions

1. Does `container exec -it` relay SIGWINCH→resize correctly when its controlling TTY is a
   supervisor-owned PTY (not a real terminal)? Spike this first; it's the only unverified
   link in the primary chain. If broken: file/patch upstream, or talk gRPC to vminitd
   directly, or fall back to ttyd.
2. `container exec` process lifetime vs `container` CLI daemonless model — does an exec
   survive `container` CLI restarts, and how fast can we respawn 10 of them (one per tab)?
3. Claude Code truecolor downsampling inside tmux (claude-code #59867) — re-test on current
   Claude Code; if still present, does forcing `TERM_PROGRAM`/`FORCE_COLOR` help?
4. Reconnecting-PTY (Coder-style server-side PTY reuse across WS drops) — worth it, or is
   respawn-exec + tmux `-A` (stateless supervisor) always good enough? Start stateless.
5. Read-only viewer mode (share a link that can watch Claude Code but not type) — trivial to
   add at the protocol layer (drop input frames server-side); decide if wanted for v1.
6. Session naming: single `main` session per worker vs one session per task — affects URL
   scheme (`/workers/:id/terminal?session=`).

## Sources

- xterm.js releases (6.0.0, 2025-12-22): https://github.com/xtermjs/xterm.js/releases
- xterm.js README / addon catalog: https://github.com/xtermjs/xterm.js/blob/master/README.md
- ttyd: https://github.com/tsl0922/ttyd — protocol: https://github.com/tsl0922/ttyd/blob/main/src/server.h and src/protocol.c (releases page: 1.7.7, 2024-03-30; commits through Aug 2026)
- wetty releases (v3.2.1, Sep 2026): https://github.com/butlerx/wetty/releases
- tty2web webtty package: https://pkg.go.dev/github.com/kost/tty2web/webtty
- Bun v1.3.5 blog (Bun.Terminal): https://bun.com/blog/bun-v1.3.5 — API ref: https://bun.com/reference/bun/Terminal
- Bun PTY issue/PR history: https://github.com/oven-sh/bun/issues/22468 , https://github.com/oven-sh/bun/pull/25415
- node-pty (1.1.0): https://github.com/microsoft/node-pty
- Apple Containerization (vminitd, gRPC over vsock): https://github.com/apple/containerization
- Apple container CLI command reference (`container exec` flags): https://github.com/apple/container/blob/main/docs/command-reference.md
- Anil Madhavapeddy on Containerization internals: https://anil.recoil.org/notes/apple-containerisation
- Firecracker vsock (UDS + CONNECT handshake): https://github.com/firecracker-microvm/firecracker/blob/main/docs/vsock.md
- tmux Control Mode wiki: https://github.com/tmux/tmux/wiki/Control-Mode — iTerm2 tmux integration: https://iterm2.com/documentation-tmux-integration.html
- Coder web terminal docs: https://coder.com/docs/user-guides/workspace-access/web-terminal — agent/reconnecting-PTY architecture: https://deepwiki.com/coder/coder/3.1-agent-architecture
- Claude Code terminal issues: truecolor in tmux https://github.com/anthropics/claude-code/issues/59867 ; flicker / DEC 2026 https://github.com/anthropics/claude-code/issues/37283 ; scroll-event storms in multiplexers https://github.com/anthropics/claude-code/issues/9935
- Go pieces: https://github.com/creack/pty , https://github.com/coder/websocket , https://github.com/gorilla/websocket
