import { join } from "path";
import { homedir } from "os";

export const VERSION = "0.3.2";

export const config = {
  port: Number(process.env.SADBOX_PORT ?? 7070),
  // localhost by default (plain HTTP; front it with TLS before exposing it) —
  // SADBOX_HOST=0.0.0.0 listens on every interface
  host: process.env.SADBOX_HOST ?? "localhost",
  // sign-in for the UI/API: on unless SADBOX_AUTH=off (only sensible when
  // something in front already authenticates every request, WebSockets included)
  auth: process.env.SADBOX_AUTH === "off" ? "off" : "on",
  // when set, this is the password (instead of the one stored in the data dir)
  password: process.env.SADBOX_PASSWORD || undefined,
  // the egress proxy that every project VM routes its traffic through.
  proxyPort: Number(process.env.SADBOX_PROXY_PORT ?? 7071),
  // where the proxy binds on the host. All interfaces by default — a VM
  // network's gateway address only exists while a VM is up, so it cannot be
  // bound at start — and the proxy itself refuses any client that is not a
  // project VM. SADBOX_PROXY_HOST overrides.
  proxyHost: process.env.SADBOX_PROXY_HOST || undefined,
  // New project VMs get NO network interface ("none"): they cannot reach the
  // internet, this machine, the LAN or each other. The only way out is a private
  // socket to the egress proxy, which decides what may pass. Set
  // SADBOX_NETWORK=default for Apple's NAT network instead (direct internet,
  // rules not enforced).
  network: process.env.SADBOX_NETWORK ?? "none",
  // the proxy as a network-less VM sees it: a relay on the guest's own loopback,
  // fed by connections the host dials into guestCarrierSocket
  guestProxyPort: 7071,
  guestCarrierSocket: "/run/sadbox/proxy.sock",
  guestToolsDir: "/usr/local/lib/sadbox",
  guestBun: "/home/agent/.bun/bin/bun",
  // where inbound port forwards (host port → VM port) listen. All interfaces by
  // default, so a forwarded app is reachable at <web UI's domain>:<port> from
  // wherever the UI is — including when the UI itself sits on localhost behind
  // a reverse proxy. Forwards are served as-is (no TLS, no auth in front);
  // set SADBOX_FORWARD_HOST=localhost to keep them on this machine only.
  forwardHost: process.env.SADBOX_FORWARD_HOST ?? "0.0.0.0",
  // how long a blocked request is held awaiting an approve/deny decision
  approvalTimeoutMs: Number(process.env.SADBOX_APPROVAL_TIMEOUT_MS ?? 120_000),
  // per-user state dir — works the same for a repo checkout or an installed binary
  dataDir: process.env.SADBOX_DATA ?? join(homedir(), ".sadbox"),
  // base image every project VM boots from; built by `sadbox setup`.
  // fallbacks keep older dev checkouts working until they rebuild.
  baseImage: process.env.SADBOX_BASE_IMAGE ?? "sadbox-base:latest",
  baseImageFallbacks: ["sadbox-worker:latest", "sadbox-worker:spike-b"],
  containerBin: process.env.SADBOX_CONTAINER_BIN ?? "container",
  // where Apple's container service keeps each VM's files and configuration
  containerDataDir: process.env.SADBOX_CONTAINER_DATA ?? join(homedir(), "Library", "Application Support", "com.apple.container"),
  guestUser: "agent",
  guestHome: "/home/agent",
  guestWorkdir: "/home/agent/workdir",
  guestSecretsFile: "/home/agent/.sadbox/env",
  guestNetEnvFile: "/home/agent/.sadbox/net.env",
  // where the proxy CA lands in the guest, and the system bundle it feeds into
  guestCaPath: "/usr/local/share/ca-certificates/sadbox-proxy.crt",
  guestCaBundle: "/etc/ssl/certs/ca-certificates.crt",
  tmuxSession: "main",
};

// per-project proxy sockets (one per VM, so the proxy knows who is asking)
export const runDir = () => join(config.dataDir, "run");
export const dbPath = () => join(config.dataDir, "sadbox.db");
export const keyPath = () => join(config.dataDir, "master.key");

// proxy CA + reusable leaf material (generated on first proxy start)
export const caCertPath = () => join(config.dataDir, "proxy-ca.crt");
export const caKeyPath = () => join(config.dataDir, "proxy-ca.key");
export const proxyLeafKeyPath = () => join(config.dataDir, "proxy-leaf.key");
export const proxyLeafCsrPath = () => join(config.dataDir, "proxy-leaf.csr");
