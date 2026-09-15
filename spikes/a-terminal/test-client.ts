// Headless check of the WS↔PTY↔tmux chain: connect, run stty, resize, re-run stty.
const url = process.env.URL ?? "ws://localhost:7071/term?cols=100&rows=30";
const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";
const dec = new TextDecoder();
const enc = new TextEncoder();
let buf = "";
ws.onmessage = (e) => { buf += dec.decode(new Uint8Array(e.data as ArrayBuffer)); };
ws.onerror = () => { console.log("FAIL: websocket error"); process.exit(1); };

ws.onopen = async () => {
  await Bun.sleep(1000); // let tmux come up
  ws.send(enc.encode("stty size; printf 'MARK1 %s %s\\n' \"$TERM\" \"$COLORTERM\"\r"));
  await Bun.sleep(600);
  ws.send(JSON.stringify({ type: "resize", cols: 132, rows: 43 }));
  await Bun.sleep(600);
  ws.send(enc.encode("stty size; echo MARK2\r"));
  await Bun.sleep(800);

  const clean = buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>]/g, "");
  // tmux's status bar takes one row, so the shell sees rows-1
  const initialOk = clean.includes("29 100");
  const resizeOk = clean.includes("42 132");
  const termOk = /MARK1 (tmux-256color|screen-256color|xterm-256color) truecolor/.test(clean);
  console.log("--- captured (cleaned) ---");
  console.log(clean.split("\n").filter((l) => /\d+ \d+|MARK/.test(l)).join("\n"));
  console.log("--- results ---");
  console.log(`initial size 100x30 seen by shell: ${initialOk ? "PASS" : "FAIL"}`);
  console.log(`resize to 132x43 propagated:       ${resizeOk ? "PASS" : "FAIL"}`);
  console.log(`TERM/COLORTERM inside tmux:        ${termOk ? "PASS" : "FAIL"}`);
  ws.close();
  process.exit(initialOk && resizeOk && termOk ? 0 : 1);
};
