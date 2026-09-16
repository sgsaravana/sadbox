import { join } from "path";
import { homedir } from "os";

export const VERSION = "0.1.0";

export const config = {
  port: Number(process.env.SADBOX_PORT ?? 7070),
  // localhost by default (no auth yet) — set SADBOX_HOST=0.0.0.0 to expose
  host: process.env.SADBOX_HOST ?? "localhost",
  // the egress proxy that every project VM routes its traffic through.
  proxyPort: Number(process.env.SADBOX_PROXY_PORT ?? 7071),
  // where the proxy binds on the host. Default: the vmnet gateway (guest-only,
  // e.g. 192.168.64.1) auto-detected at start; SADBOX_PROXY_HOST overrides.
  proxyHost: process.env.SADBOX_PROXY_HOST || undefined,
  // how long a blocked request is held awaiting an approve/deny decision
  approvalTimeoutMs: Number(process.env.SADBOX_APPROVAL_TIMEOUT_MS ?? 120_000),
  // per-user state dir — works the same for a repo checkout or an installed binary
  dataDir: process.env.SADBOX_DATA ?? join(homedir(), ".sadbox"),
  // base image every project VM boots from; built by `sadbox setup`.
  // fallbacks keep older dev checkouts working until they rebuild.
  baseImage: process.env.SADBOX_BASE_IMAGE ?? "sadbox-base:latest",
  baseImageFallbacks: ["sadbox-worker:latest", "sadbox-worker:spike-b"],
  containerBin: process.env.SADBOX_CONTAINER_BIN ?? "container",
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

export const dbPath = () => join(config.dataDir, "sadbox.db");
export const keyPath = () => join(config.dataDir, "master.key");

// proxy CA + reusable leaf material (generated on first proxy start)
export const caCertPath = () => join(config.dataDir, "proxy-ca.crt");
export const caKeyPath = () => join(config.dataDir, "proxy-ca.key");
export const proxyLeafKeyPath = () => join(config.dataDir, "proxy-leaf.key");
export const proxyLeafCsrPath = () => join(config.dataDir, "proxy-leaf.csr");
