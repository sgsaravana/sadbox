// The two small programs sadbox places inside a VM. A VM has no network
// interface, so:
//   relay.js   — what HTTP(S)_PROXY points at. It listens on the guest's
//                loopback for the VM's programs, and on a unix socket that is
//                published to the host. The host keeps a few idle connections
//                ("carriers") dialed into that socket; each program that
//                connects is joined to one, and from then on that carrier is an
//                ordinary proxy connection. The host is always the one dialing,
//                so the supervisor can restart without the VM noticing more
//                than a short wait.
//   connect.js — bridges its stdin/stdout to a port on the guest's loopback, so
//                the host can reach an app in the VM over `exec` (port forwards).
// Both run on the Bun that the base image already ships. They are installed
// root-owned, outside the agent's home.
import { config } from "../config";
import { getDriver } from "../driver";

const driver = getDriver();

const RELAY_JS = `const net = require("node:net"), fs = require("node:fs"), path = require("node:path");
const [port, sock] = [Number(process.argv[2]), process.argv[3]];
const carriers = [], waiting = [];
const drop = (list, x) => { const i = list.indexOf(x); if (i >= 0) list.splice(i, 1); };

function join(w, u) {
  const c = w.c; w.u = u;
  u.on("data", (d) => { if (!c.write(d)) u.pause(); });
  c.on("drain", () => u.resume()); u.on("drain", () => c.resume());
  u.on("end", () => c.end()); u.on("close", () => c.destroy());
  for (const d of w.buf) u.write(d);
  w.buf = [];
  if (w.ended) u.end();
}
function pair() {
  while (carriers.length && waiting.length) {
    const u = carriers.shift(), w = waiting.shift();
    clearTimeout(w.timer); join(w, u);
  }
}

fs.mkdirSync(path.dirname(sock), { recursive: true });
try { fs.unlinkSync(sock); } catch {}
net.createServer((u) => {                       // a carrier, dialed in by the host
  u.on("error", () => {}); u.on("close", () => drop(carriers, u));
  carriers.push(u); pair();
}).listen(sock);

net.createServer((c) => {                       // a program in this VM
  const w = { c, u: null, buf: [], ended: false, timer: null };
  c.on("error", () => {});
  c.on("data", (d) => { if (!w.u) w.buf.push(d); else if (!w.u.write(d)) c.pause(); });
  c.on("end", () => { w.ended = true; if (w.u) w.u.end(); });
  c.on("close", () => { clearTimeout(w.timer); drop(waiting, w); if (w.u) w.u.destroy(); });
  // no carrier free: the supervisor is busy or restarting — wait a little for one
  w.timer = setTimeout(() => c.destroy(), 20000);
  waiting.push(w); pair();
}).listen(port, "127.0.0.1");
`;

const CONNECT_JS = `const net = require("node:net");
const s = net.connect(Number(process.argv[2]), "127.0.0.1");
s.on("connect", () => {
  process.stdin.on("data", (d) => { if (!s.write(d)) process.stdin.pause(); });
  s.on("drain", () => process.stdin.resume());
  process.stdin.on("end", () => s.end());
  s.on("data", (d) => { if (!process.stdout.write(d)) s.pause(); });
  process.stdout.on("drain", () => s.resume());
});
s.on("error", () => process.exit(1));
// let stdout flush what the app sent before exiting
s.on("close", () => process.stdout.write("", () => process.exit(0)));
`;

// `sadbox-vault`: the vault from inside the VM (docs/research/12, V5). It asks
// the proxy for http://vault.sadbox.internal, which the proxy answers itself.
// Errors go to stderr with a non-zero exit, so `$(sadbox-vault get X)` never
// captures an error message as a value.
const VAULT_SH = `#!/bin/sh
# sadbox-vault — this project's vault items, fetched at runtime.
#   sadbox-vault list              the items this project may use (no values)
#   sadbox-vault get NAME          an item's value on stdout — may wait for the owner to allow it
#   sadbox-vault get --json NAME   {"name", "type", "value"}
# A proxy item is not fetched: its placeholder is in $NAME, and the proxy swaps in the value.
[ -f ${config.guestNetEnvFile} ] && . ${config.guestNetEnvFile}
proxy="\${HTTP_PROXY:-http://127.0.0.1:${config.guestProxyPort}}"
base=http://vault.sadbox.internal/v1
q() {
  umask 077; tmp=$(mktemp) || exit 1
  code=$(curl -sS --max-time 180 --proxy "$proxy" -o "$tmp" -w '%{http_code}' "$1") || { rm -f "$tmp"; exit 1; }
  if [ "$code" -ge 400 ]; then cat "$tmp" >&2; rm -f "$tmp"; exit 1; fi
  cat "$tmp"; rm -f "$tmp"
}
case "$1" in
  list|"") q "$base/" ;;
  get)
    shift; fmt=""
    [ "$1" = "--json" ] && { fmt="?format=json"; shift; }
    [ -n "$1" ] || { echo "usage: sadbox-vault get [--json] NAME" >&2; exit 2; }
    q "$base/$1$fmt" ;;
  -h|--help|help) sed -n '2,6p' "$0" | cut -c3- ;;
  *) echo "usage: sadbox-vault list | get [--json] NAME" >&2; exit 2 ;;
esac
`;

// `git-credential-sadbox`: git's credential helper in every VM (system-wide).
// For an https host it asks the proxy for the vault's proxy item bound to that
// host and hands git its placeholder as the password — git sends it in Basic
// auth and the proxy swaps in the real token. So `git clone https://github.com/…`
// works with the vault's GITHUB_TOKEN, and the token never enters the VM. A
// token given to the project itself (~/.git-credentials) is left to go first;
// with nothing in the vault for the host, git carries on as it would without.
const GIT_CREDENTIAL_SH = `#!/bin/sh
[ "$1" = get ] || exit 0
proto= host=
while IFS= read -r l && [ -n "$l" ]; do
  case "$l" in protocol=*) proto=\${l#protocol=} ;; host=*) host=\${l#host=} ;; esac
done
[ "$proto" = https ] && [ -n "$host" ] || exit 0
grep -qsF "@$host" "$HOME/.git-credentials" && exit 0
[ -f ${config.guestNetEnvFile} ] && . ${config.guestNetEnvFile}
proxy="\${HTTP_PROXY:-http://127.0.0.1:${config.guestProxyPort}}"
curl -sf --max-time 15 --proxy "$proxy" "http://vault.sadbox.internal/git/credential?host=$host" || exit 0
`;

const relayPath = `${config.guestToolsDir}/relay.js`;
const connectPath = `${config.guestToolsDir}/connect.js`;

const installed = new Set<string>(); // refs written to since this supervisor started

/** Write the guest programs into the VM (idempotent; once per supervisor run). */
export async function ensureGuestTools(ref: string): Promise<void> {
  if (installed.has(ref)) return;
  const script =
    `mkdir -p ${config.guestToolsDir} && ` +
    `cat > ${relayPath} <<'SADBOX_EOF'\n${RELAY_JS}SADBOX_EOF\n` +
    `cat > ${connectPath} <<'SADBOX_EOF'\n${CONNECT_JS}SADBOX_EOF\n` +
    `cat > /usr/local/bin/sadbox-vault <<'SADBOX_EOF'\n${VAULT_SH}SADBOX_EOF\n` +
    `cat > /usr/local/bin/git-credential-sadbox <<'SADBOX_EOF'\n${GIT_CREDENTIAL_SH}SADBOX_EOF\n` +
    `chmod 755 ${config.guestToolsDir} /usr/local/bin/sadbox-vault /usr/local/bin/git-credential-sadbox && chmod 644 ${relayPath} ${connectPath} && ` +
    `git config --system credential.helper sadbox`;
  const r = await driver.exec(ref, ["sh", "-c", script], { user: "root" });
  if (r.exitCode !== 0) throw new Error(`could not install guest tools: ${r.stderr.trim()}`);
  installed.add(ref);
}

/** A VM was recreated under the same name: its filesystem is new. */
export const forgetGuestTools = (ref: string) => { installed.delete(ref); };

/** Start the proxy relay in a network-less VM, unless it is already running.
 *  Runs as root so the agent's own processes cannot take its place by accident. */
export async function startGuestRelay(ref: string): Promise<void> {
  await ensureGuestTools(ref);
  // "Is it running" = "is the port answering" (matching on the process list
  // would match this very command line). Then wait until it accepts
  // connections — the caller uses it at once.
  const r = await driver.exec(ref, ["bash", "-c",
    `up() { (exec 3<>/dev/tcp/127.0.0.1/${config.guestProxyPort}) 2>/dev/null; }; ` +
    `up || (setsid nohup ${config.guestBun} ${relayPath} ${config.guestProxyPort} ${config.guestCarrierSocket} >/dev/null 2>&1 &); ` +
    `for i in $(seq 50); do up && exit 0; sleep 0.1; done; ` +
    `echo "relay did not start listening" >&2; exit 1`,
  ], { user: "root" });
  if (r.exitCode !== 0) throw new Error(`could not start the proxy relay in the VM: ${r.stderr.trim()}`);
}

/** Shell command that bridges stdin/stdout to a port on the guest's loopback. */
export const guestConnectCmd = (port: number) => `exec ${config.guestBun} ${connectPath} ${Math.trunc(port)}`;
