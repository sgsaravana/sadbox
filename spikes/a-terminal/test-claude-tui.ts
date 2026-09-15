// Launch `claude` inside the worker's tmux via the WS bridge and look for TUI output.
const ws = new WebSocket("ws://localhost:7071/term?cols=120&rows=35");
ws.binaryType = "arraybuffer";
const dec = new TextDecoder();
const enc = new TextEncoder();
let buf = "";
ws.onmessage = (e) => { buf += dec.decode(new Uint8Array(e.data as ArrayBuffer)); };

ws.onopen = async () => {
  await Bun.sleep(1200);
  ws.send(enc.encode("claude\r"));
  await Bun.sleep(8000);
  const snapshot = buf;
  // tear down: Ctrl+C twice to leave claude, don't kill the tmux session
  ws.send(enc.encode("\x03"));
  await Bun.sleep(400);
  ws.send(enc.encode("\x03"));
  await Bun.sleep(600);

  const clean = snapshot.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]|\x1b\([B0]/g, "");
  const altScreen = snapshot.includes("\x1b[?1049h");
  const truecolorOut = /\x1b\[38;2;\d+;\d+;\d+m/.test(snapshot);
  const claudeText = /(Claude Code|claude\.ai|Anthropic|theme|Welcome)/i.test(clean);
  console.log("--- text seen (unique lines, trimmed) ---");
  console.log([...new Set(clean.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 3))].slice(0, 25).join("\n"));
  console.log("--- results ---");
  console.log(`bytes received:              ${snapshot.length}`);
  console.log(`alt-screen TUI started:      ${altScreen ? "PASS" : "FAIL"}`);
  console.log(`truecolor SGR in output:     ${truecolorOut ? "PASS" : "(none seen)"}`);
  console.log(`Claude Code text present:    ${claudeText ? "PASS" : "FAIL"}`);
  ws.close();
  process.exit(altScreen && claudeText ? 0 : 1);
};
