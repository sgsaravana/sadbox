// Secret encryption at rest: AES-256-GCM with a data-dir keyfile.
// Research (docs/research/05) prescribes an envelope scheme with the KEK in
// the macOS Keychain / compose secret; this keyfile is the v0 stand-in — same
// call sites, swappable key source.
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { existsSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from "fs";
import { dirname } from "path";
import { keyPath } from "./config";

let key: Buffer | null = null;

function masterKey(): Buffer {
  if (key) return key;
  const p = keyPath();
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, randomBytes(32));
    chmodSync(p, 0o600);
  }
  key = readFileSync(p);
  if (key.length !== 32) throw new Error(`master key at ${p} is not 32 bytes`);
  return key;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decrypt(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
