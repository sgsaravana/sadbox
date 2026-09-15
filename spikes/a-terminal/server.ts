// Spike A — browser xterm.js ⇄ WebSocket ⇄ Bun.Terminal (PTY) ⇄ tmux
//
// Targets (TARGET env var):
//   local      (default) attach to a tmux session on the host — proves the
//              bridge with identical PTY semantics before `container` exists
//   container  attach to tmux inside a worker microVM via
//              `container exec -it $WORKER tmux new-session -A -s main`
//
// Wire protocol (one WebSocket per terminal tab):
//   binary frames  = raw terminal bytes, both directions
//   text frames    = JSON control messages, client→server only:
//                    {"type":"resize","cols":N,"rows":N}

import { join } from "path";

const ROOT = import.meta.dir;
const PORT = Number(process.env.PORT ?? 7071);
const TARGET = process.env.TARGET ?? "local";
const WORKER = process.env.WORKER ?? "spike-a";
const SESSION = process.env.SESSION ?? "spike-a";

function termCommand(): string[] {
  if (TARGET === "container") {
    // bare --env keys inherit from this process: TERM comes from Bun.Terminal's
    // `name`, COLORTERM from the spawn env below
    return ["container", "exec", "-it", "--env", "TERM", "--env", "COLORTERM",
            WORKER, "tmux", "new-session", "-A", "-s", "main"];
  }
  return ["tmux", "-f", join(ROOT, "spike-tmux.conf"), "new-session", "-A", "-s", SESSION];
}

const STATIC: Record<string, [path: string, type: string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/xterm.js": ["node_modules/@xterm/xterm/lib/xterm.js", "text/javascript"],
  "/xterm.css": ["node_modules/@xterm/xterm/css/xterm.css", "text/css"],
  "/addon-fit.js": ["node_modules/@xterm/addon-fit/lib/addon-fit.js", "text/javascript"],
};

type Conn = { cols: number; rows: number; proc?: ReturnType<typeof Bun.spawn> };

const server = Bun.serve<Conn>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/term") {
      const cols = Math.max(2, Number(url.searchParams.get("cols")) || 80);
      const rows = Math.max(2, Number(url.searchParams.get("rows")) || 24);
      if (server.upgrade(req, { data: { cols, rows } })) return;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    const hit = STATIC[url.pathname];
    if (hit) {
      return new Response(Bun.file(join(ROOT, hit[0])), {
        headers: { "content-type": hit[1] },
      });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const cmd = termCommand();
      const proc = Bun.spawn(cmd, {
        // TERM must be pinned here: Bun.Terminal's `name` does not override an
        // inherited TERM, and the guest lacks terminfo for exotic host terminals
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
        terminal: {
          cols: ws.data.cols,
          rows: ws.data.rows,
          name: "xterm-256color",
          data(_term, chunk: Uint8Array) {
            ws.send(chunk);
          },
          exit() {
            try { ws.close(1000, "terminal closed"); } catch {}
          },
        },
      });
      ws.data.proc = proc;
      proc.exited.then(() => {
        try { ws.close(1000, "process exited"); } catch {}
      });
      console.log(`[spike-a] +conn pid=${proc.pid} ${ws.data.cols}x${ws.data.rows} cmd=${cmd.join(" ")}`);
    },
    message(ws, msg) {
      const term = ws.data.proc?.terminal;
      if (!term) return;
      if (typeof msg === "string") {
        try {
          const ctl = JSON.parse(msg);
          if (ctl.type === "resize") term.resize(ctl.cols, ctl.rows);
        } catch {}
        return;
      }
      term.write(msg);
    },
    close(ws) {
      // Kill only the attach client; the tmux session (host or in-VM) survives.
      const proc = ws.data.proc;
      if (proc) {
        console.log(`[spike-a] -conn pid=${proc.pid}`);
        proc.kill();
      }
    },
  },
});

console.log(`[spike-a] target=${TARGET} listening on http://localhost:${server.port}`);
