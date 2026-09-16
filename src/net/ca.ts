// Proxy CA + on-the-fly leaf certs for TLS interception (MITM).
//
// A single CA (persisted in the data dir) is trusted inside every project VM;
// per-host leaf certs are minted lazily and signed by it so the guest's TLS
// clients see a valid chain for whatever host they dial. All openssl calls are
// ASYNC (Bun.spawn) — a synchronous spawn would block Bun's single event loop
// and deadlock the proxy mid-handshake (learned the hard way in spikes).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  config, caCertPath, caKeyPath, proxyLeafKeyPath, proxyLeafCsrPath,
} from "../config";

async function openssl(args: string[], input?: Uint8Array) {
  const p = Bun.spawn(["openssl", ...args], {
    stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  return { code, out, err };
}

let caPem = "";
let leafKeyPem = "";

/** Generate the CA + a reusable leaf key/CSR once; load them into memory. */
export async function ensureCA(): Promise<void> {
  mkdirSync(config.dataDir, { recursive: true });
  const caCrt = caCertPath(), caKey = caKeyPath();
  const leafKey = proxyLeafKeyPath(), leafCsr = proxyLeafCsrPath();

  if (!existsSync(caCrt) || !existsSync(caKey)) {
    const r = await openssl([
      "req", "-x509", "-newkey", "rsa:2048", "-keyout", caKey, "-out", caCrt,
      "-days", "3650", "-nodes", "-subj", "/CN=sadbox proxy CA/O=sadbox",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    if (r.code !== 0) throw new Error(`CA generation failed: ${r.err.trim()}`);
  }
  if (!existsSync(leafKey)) {
    const r = await openssl(["genrsa", "-out", leafKey, "2048"]);
    if (r.code !== 0) throw new Error(`leaf key gen failed: ${r.err.trim()}`);
  }
  if (!existsSync(leafCsr)) {
    const r = await openssl(["req", "-new", "-key", leafKey, "-out", leafCsr, "-subj", "/CN=sadbox-leaf"]);
    if (r.code !== 0) throw new Error(`leaf CSR gen failed: ${r.err.trim()}`);
  }
  caPem = readFileSync(caCrt, "utf8");
  leafKeyPem = readFileSync(leafKey, "utf8");
}

export function caCertPem(): string { return caPem; }
export function leafKey(): string { return leafKeyPem; }
export function caReady(): boolean { return caPem !== "" && leafKeyPem !== ""; }

// host -> chain PEM (leaf cert + CA), minted once and cached
const certCache = new Map<string, Promise<string>>();
// unique serials (seeded off the clock) so parallel mints never collide on a
// shared .srl file — avoids -CAcreateserial races.
let serialSeq = Date.now();

export function certForHost(host: string): Promise<string> {
  let pr = certCache.get(host);
  if (pr) return pr;
  pr = mintCert(host).catch((e) => { certCache.delete(host); throw e; });
  certCache.set(host, pr);
  return pr;
}

async function mintCert(host: string): Promise<string> {
  const safe = host.replace(/[^a-zA-Z0-9._-]/g, "_");
  const extFile = join(config.dataDir, `.leaf-${safe}.cnf`);
  const crtFile = join(config.dataDir, `.leaf-${safe}.crt`);
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  writeFileSync(extFile,
    `subjectAltName=${isIp ? "IP" : "DNS"}:${host}\n` +
    `basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
  const r = await openssl([
    "x509", "-req", "-in", proxyLeafCsrPath(), "-CA", caCertPath(), "-CAkey", caKeyPath(),
    "-set_serial", String(serialSeq++), "-days", "825", "-extfile", extFile, "-out", crtFile,
  ]);
  if (r.code !== 0) throw new Error(`cert mint failed for ${host}: ${r.err.trim()}`);
  return readFileSync(crtFile, "utf8") + caPem;
}
