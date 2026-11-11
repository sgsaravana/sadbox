// A stand-in for vfkit, for the vz driver's tests on any machine
// (src/driver/vz/vz.test.ts). Takes vfkit's arguments; instead of a VM it runs
// sadbox-agent ($SADBOX_TEST_AGENT_BIN) here on a unix socket, and serves what
// the driver uses of vfkit:
//
//   * the host-dials-in vsock port (`connect`): a unix socket that, per
//     connection, dials the agent — as vfkit's tcpproxy does;
//   * the guest→host port (`listen`): nothing to do, the agent dials the host
//     unix socket itself (the driver is listening there);
//   * the REST API on --restful-uri (vm/state), and a console log file.
//
// It exits when the agent does (a poweroff), as vfkit exits when the VM stops.
import net from "node:net";
import { chmodSync, rmSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const value = (name: string) => argv[argv.indexOf(name) + 1] ?? "";
function device(spec: string) {
  const [type, ...opts] = spec.split(",");
  const kv: Record<string, string> = {};
  for (const o of opts) { const [k, ...v] = o.split("="); kv[k] = v.join("="); }
  return { type, opts: kv };
}
const devices = argv.flatMap((a, i) => (a === "--device" ? [device(argv[i + 1])] : []));
const vsocks = devices.filter((d) => d.type === "virtio-vsock").map((d) => ({
  port: Number(d.opts.port), socketURL: d.opts.socketURL, connect: "connect" in d.opts,
}));
const serial = devices.find((d) => d.type === "virtio-serial")?.opts.logFilePath;

const boot = value("--bootloader");
const cmdline = boot.split(",").find((p) => p.startsWith("cmdline="))?.slice("cmdline=".length) ?? "";
const announcePort = Number(cmdline.match(/sadbox\.announce=(\d+)/)?.[1] ?? 0);

if (process.env.SADBOX_TEST_FAKE_VFKIT_FAIL) { console.error("Error: fake vfkit told to fail"); process.exit(1); }

const toGuest = vsocks.find((v) => v.connect && v.port === 1024);
const fromGuest = vsocks.find((v) => !v.connect && v.port === announcePort);
if (!toGuest) { console.error("fake vfkit: no host→guest vsock device"); process.exit(2); }

if (serial) writeFileSync(serial, `fake vfkit: ${argv.join(" ")}\n`);
const agentSock = `${toGuest.socketURL}.agent`;
rmSync(agentSock, { force: true });
rmSync(toGuest.socketURL, { force: true });

const agent = Bun.spawn([process.env.SADBOX_TEST_AGENT_BIN!, "-init", "off", "-listen", `unix:${agentSock}`,
  ...(fromGuest ? ["-announce", `unix:${fromGuest.socketURL}`] : [])], { stderr: "ignore" });

const servers: { close(): void }[] = [];

function quit(code = 0) {
  for (const s of servers) { try { s.close(); } catch {} }
  try { agent.kill(); } catch {}
  try { const rest = value("--restful-uri").replace(/^unix:\/\//, ""); if (rest) rmSync(rest, { force: true }); } catch {}
  process.exit(code);
}
const proxy = net.createServer((c) => {
  c.on("error", () => {});
  const up = net.connect(agentSock, () => { c.pipe(up).pipe(c); });
  up.on("error", () => c.destroy());
}).listen(toGuest.socketURL, () => { try { chmodSync(toGuest.socketURL, 0o600); } catch {} });
servers.push(proxy);

const rest = value("--restful-uri").replace(/^unix:\/\//, "");
if (rest) {
  rmSync(rest, { force: true });
  const server = Bun.serve({
    unix: rest,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path !== "/vm/state") return new Response(null, { status: 404 });
      if (req.method === "POST") { setTimeout(() => quit(), 10); return new Response(null, { status: 202 }); }
      return Response.json({ state: "VirtualMachineStateRunning", canHardStop: true });
    },
  });
  servers.push({ close: () => server.stop(true) });
}

agent.exited.then(() => quit());
