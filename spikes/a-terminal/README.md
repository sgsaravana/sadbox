# Spike A — web terminal into tmux

Proves the sadbox terminal chain from `docs/research/04-tmux-web-terminal.md`:

```
xterm.js 6 ⇄ WebSocket ⇄ Bun.Terminal (PTY) ⇄ tmux
                                       └─ local host tmux   (TARGET=local)
                                       └─ container exec -it <worker> tmux new -A -s main   (TARGET=container)
```

## Run

```sh
bun run server.ts                 # local target, http://localhost:7071
TARGET=container WORKER=spike-a bun run server.ts   # microVM target
```

Open http://localhost:7071 — full-window terminal attached to
`tmux new-session -A -s spike-a`. Open a second tab to see multi-viewer
behavior. Run `sh colors.sh` inside for the truecolor check.

Headless check (server must be running):

```sh
bun run test-client.ts
```

## Wire protocol

One WebSocket per tab at `/term?cols=N&rows=N`.
Binary frames carry raw terminal bytes both ways; text frames are JSON
control messages (client→server): `{"type":"resize","cols":N,"rows":N}`.

## Status

| Check | local (host tmux) | container (microVM) |
|---|---|---|
| Keystrokes + output round-trip | ✅ 2026-09-15 | ✅ 2026-09-15 |
| Initial PTY size honored | ✅ (`stty` = rows−1 for tmux status bar) | ✅ |
| Live resize propagates into tmux | ✅ 132×43 → `stty 42 132` | ✅ — **research's open question, closed** (~20 ms redraw) |
| TERM/COLORTERM (`tmux-256color` + `truecolor`) | ✅ | ✅ |
| tmux session survives disconnect, `new -A` reattaches | ✅ | ✅ (scrollback intact across probe→WS reattach) |
| Truecolor gradient by eye (`colors.sh`) | 👀 open in browser | 👀 open in browser |
| Claude Code renders correctly in tmux | ⏳ | ⏳ needs guest image + auth (Spike B/C territory) |

Environment: Bun 1.3.14, `container` 1.4.1 (brew), Kata kernel 3.32.0
(guest reports 6.18.35), Debian bookworm-slim guest, tmux 3.3a in guest,
tmux 3.6a on host. Worker create: ~17 s cold with image pulls; exec attach
over vsock: ~140 ms.

## Findings

- `Bun.spawn({ terminal })` (Bun ≥ 1.3.5; tested on 1.3.14) provides the PTY:
  `data`/`exit` callbacks out, `write()`/`resize()` in. No node-pty needed.
- **Pin `TERM` in the spawn env.** Bun.Terminal's `name` option does NOT
  override an inherited `TERM`; with `--env TERM` forwarding, the guest saw
  `xterm-ghostty`, had no terminfo for it, and tmux refused to start
  ("missing or unsuitable terminal"). Always spawn with
  `TERM=xterm-256color` explicitly.
- **Always `terminal.close()` on teardown** — the Terminal refs the event
  loop; `proc.kill()` alone leaves the process hanging.
- Guest needs `ncurses-term` (for `tmux-256color` terminfo) and a
  `~/.tmux.conf` with `default-terminal tmux-256color` +
  `terminal-features ',xterm-256color:RGB'` — bake both into the worker image.
- `container exec -e KEY` (bare key) inherits that var from the host-side
  process env — handy, but see the TERM gotcha above.
- tmux's status bar consumes one row — the shell always sees `rows − 1`.
- `tmux new-session -A` makes connect idempotent: no create-vs-attach race,
  and reconnecting picks up the running session with scrollback intact.
- Debian bookworm ships tmux **3.3a < 3.4**, i.e. no synchronized-output
  passthrough — the flicker fix for Claude Code TUIs needs tmux ≥ 3.4 in the
  worker image (backports or trixie base). Address in Spike B.

## Verdict

**Spike A passes.** The full chain — xterm.js 6 ⇄ WebSocket ⇄ Bun PTY ⇄
`container exec -it` ⇄ vsock ⇄ tmux in a microVM — works, including live
resize. The terminal architecture from `docs/research/04-tmux-web-terminal.md`
is confirmed buildable with zero guest daemons.

## Next (Spike B)

Build the real worker image (Debian + curl + bun + tmux ≥ 3.4 + Claude Code
baked in), measure create-to-tmux-ready latency including workdir copy-in,
and eyeball Claude Code rendering through this bridge.
