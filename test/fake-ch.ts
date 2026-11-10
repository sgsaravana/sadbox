// A stand-in for Cloud Hypervisor, for the KVM driver's tests on any machine
// (src/driver/kvm/kvm.test.ts). Takes CH's arguments; instead of a VM it runs
// sadbox-agent ($SADBOX_TEST_AGENT_BIN) here, and serves what the driver uses
// of CH: the REST API on --api-socket (vm.info, vm.counters, vmm.shutdown) and
// the hybrid vsock on --vsock (CONNECT 1024 → the agent; the agent's dial to
// the host's port P → <socket>_P). It exits when the agent does (a poweroff).
import net from "node:net";
import { rmSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (name: string) => argv[argv.indexOf(name) + 1] ?? "";
const kv = (s: string) => Object.fromEntries(s.split(",").map((p) => p.split("=") as [string, string]));
const apiSock = kv(opt("--api-socket")).path;
const vsock = kv(opt("--vsock")).socket;
const consoleFile = kv(opt("--console")).file;
const announce = opt("--cmdline").match(/sadbox\.announce=(\d+)/)?.[1];
if (process.env.SADBOX_TEST_FAKE_CH_FAIL) { console.error("Error: fake CH told to fail"); process.exit(1); }

const agentSock = `${vsock}.agent`;
writeFileSync(consoleFile, `fake boot: ${argv.join(" ")}\n`);
const agent = Bun.spawn([process.env.SADBOX_TEST_AGENT_BIN!, "-init", "off", "-listen", `unix:${agentSock}`,
  ...(announce ? ["-announce", `unix:${vsock}_${announce}`] : [])], { stderr: "ignore" });

const hybrid = net.createServer((c) => {
  c.on("error", () => {});
  c.once("data", (d) => {
    const m = d.toString().match(/^CONNECT (\d+)\n/);
    if (!m) { c.destroy(); return; }
    const up = net.connect(agentSock, () => { c.write("OK 1\n"); c.pipe(up).pipe(c); });
    up.on("error", () => c.destroy());
  });
}).listen(vsock);

const api = Bun.serve({
  unix: apiSock,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/api/v1/vm.info") return Response.json({ state: "Running" });
    if (path === "/api/v1/vm.counters") return Response.json({ _disk0: { read_bytes: 10, write_bytes: 20 } });
    if (path === "/api/v1/vmm.shutdown") { setTimeout(() => quit(), 10); return new Response(null, { status: 204 }); }
    return new Response("no", { status: 404 });
  },
});

function quit() {
  agent.kill();
  hybrid.close();
  api.stop(true);
  for (const p of [apiSock, vsock]) rmSync(p, { force: true });
  process.exit(0);
}
agent.exited.then(quit);
process.on("SIGTERM", quit);
