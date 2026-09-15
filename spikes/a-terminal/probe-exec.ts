// Probe `container exec -it … tmux` under Bun.Terminal with chunk timing.
const t0 = Date.now();
const proc = Bun.spawn(
  ["container", "exec", "-it", "--env", "TERM", "--env", "COLORTERM",
   "spike-a", "tmux", "new-session", "-A", "-s", "main"],
  {
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    terminal: {
      cols: 100, rows: 30, name: "xterm-256color",
      data(_t, chunk: Uint8Array) {
        const s = JSON.stringify(new TextDecoder().decode(chunk).slice(0, 120));
        console.log(`+${Date.now() - t0}ms data(${chunk.length}): ${s}`);
      },
      exit(_t, code, sig) { console.log(`+${Date.now() - t0}ms pty-exit code=${code} sig=${sig}`); },
    },
  },
);
proc.exited.then((code) => console.log(`+${Date.now() - t0}ms proc-exit code=${code}`));
await Bun.sleep(4000);
console.log(`+${Date.now() - t0}ms writing stty`);
proc.terminal?.write("stty size\r");
await Bun.sleep(2000);
proc.terminal?.resize(132, 43);
await Bun.sleep(1500);
proc.terminal?.write("stty size\r");
await Bun.sleep(2000);
proc.kill();
proc.terminal?.close(); // Terminal refs the event loop; close it or the process hangs
await Bun.sleep(300);
process.exit(0);
