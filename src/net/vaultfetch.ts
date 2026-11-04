// Fetch at runtime (docs/research/12, V5–V6): the vault as a VM sees it.
// A VM reaches nothing but the proxy, and the proxy knows which project a
// request comes from — so requests for http://vault.sadbox.internal are
// answered here, by the proxy itself, and never leave the machine:
//
//   GET /v1/          the items this project may use (names, kinds, types, modes — no values)
//   GET /v1/NAME      a fetch item's value, as the body (`?format=json`: {name, type, value})
//   GET /git/credential?host=H
//                     for git's credential helper: the placeholder of the proxy
//                     item bound to H, as `username=…` / `password=…` lines —
//                     never a value, so nobody is asked
//
// A fetch item that asks first holds the request for the owner's answer (an
// approval of kind `fetch`), unless an earlier answer still stands. A proxy
// item is never served: its value must not enter the VM — the VM uses the
// placeholder in its env instead. Every read is logged — in the project's
// request log (the item's name, never its value) and as an event.
import type { ServerResponse } from "node:http";
import { db, logEvent } from "../db";
import { decrypt } from "../crypto";
import { requestApproval } from "./approvals";
import { hasFetchGrant } from "./fetchgrants";
import { recordRequest } from "./events";
import { gitCredentialFor } from "./credentials";

export const VAULT_HOST = "vault.sadbox.internal";

interface Row {
  id: string;
  name: string;
  kind: string;
  value_type: "string" | "number" | "json";
  delivery: "proxy" | "fetch";
  ask_on_fetch: number;
  value_enc: string;
}

const projectItems = (projectId: string) => db.query<Row, [string]>(
  `SELECT s.id, s.name, s.kind, s.value_type, s.delivery, s.ask_on_fetch, s.value_enc
   FROM project_secrets ps JOIN secrets s ON s.id = ps.secret_id WHERE ps.project_id = ? ORDER BY s.name`,
).all(projectId);

let seq = 0;

/** Answer one request for the vault host. */
export async function serveVault(
  projectId: string | null, scheme: string, method: string, path: string, res: ServerResponse,
): Promise<void> {
  const started = Date.now();
  let served: string | null = null;
  const reply = (status: number, body: string, type = "text/plain; charset=utf-8") => {
    const bytes = Buffer.from(body, "utf8");
    try {
      res.writeHead(status, { "content-type": type, "content-length": String(bytes.length), "cache-control": "no-store" });
      res.end(bytes);
    } catch {}
    if (projectId) recordRequest(projectId, {
      id: `v${(++seq).toString(36)}-${started.toString(36)}`, ts: started, method, scheme, host: VAULT_HOST,
      path: path.split("?")[0], status, decision: status < 400 ? "allowed" : "blocked",
      reqBytes: 0, respBytes: served ? 0 : bytes.length, durationMs: Date.now() - started, // a value's size is not logged
      ...(served ? { credentials: [served] } : {}),
    });
  };
  const fail = (status: number, why: string) => reply(status, `sadbox-vault: ${why}\n`);

  if (!projectId) return fail(403, "this request does not come from a project's VM");
  if (method !== "GET") return fail(405, "only GET");
  const url = new URL(path, `http://${VAULT_HOST}`);
  if (url.pathname === "/git/credential") {
    const host = (url.searchParams.get("host") ?? "").toLowerCase().replace(/:443$/, "");
    if (!/^[a-z0-9.-]+$/.test(host)) return fail(400, "give ?host=");
    const c = gitCredentialFor(projectId, host);
    if (!c) return fail(404, `no proxy item in this project's vault is bound to ${host}`);
    logEvent(projectId, "vault.git", `${c.name} for ${host}`);
    return reply(200, `username=x-access-token\npassword=${c.placeholder}\n`);
  }
  const m = /^\/v1\/?([^/]*)$/.exec(url.pathname);
  if (!m) return fail(404, "unknown path — try /v1/ or /v1/NAME");
  const items = projectItems(projectId);

  if (!m[1]) {
    return reply(200, JSON.stringify(items.map((r) => ({
      name: r.name, kind: r.kind, type: r.value_type, mode: r.delivery,
      ...(r.delivery === "fetch" ? { asks: !!r.ask_on_fetch && !hasFetchGrant(projectId, r.id) } : {}),
    })), null, 2) + "\n", "application/json");
  }

  const name = decodeURIComponent(m[1]);
  const r = items.find((x) => x.name === name);
  if (!r) return fail(404, `this project has no vault item named ${name}`);
  if (r.delivery === "proxy") {
    logEvent(projectId, "vault.fetch", `${name}: refused (a proxy item)`);
    return fail(403, `${name} is used through the proxy: the VM has a placeholder in $${name}, and the real value never enters the VM`);
  }
  if (r.ask_on_fetch && !hasFetchGrant(projectId, r.id)) {
    const d = await requestApproval({ projectId, host: VAULT_HOST, method, scheme, path: `/v1/${name}`, fetch: { secretId: r.id, name } });
    if (d !== "allow") {
      logEvent(projectId, "vault.fetch", `${name}: denied`);
      return fail(403, `reading ${name} was not allowed`);
    }
  }
  const value = decrypt(r.value_enc);
  served = name;
  logEvent(projectId, "vault.fetch", `${name}: served`);
  if (url.searchParams.get("format") === "json") {
    return reply(200, JSON.stringify({ name, type: r.value_type, value: r.value_type === "string" ? value : JSON.parse(value) }) + "\n", "application/json");
  }
  return reply(200, value, r.value_type === "json" ? "application/json" : "text/plain; charset=utf-8");
}
