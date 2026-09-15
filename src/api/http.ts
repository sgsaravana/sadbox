import { join, resolve, dirname } from "path";
import { homedir } from "os";
import { existsSync, readdirSync, statSync } from "fs";
import { config } from "../config";
import { staticRoutes } from "../assets";
import { getDriver } from "../driver";
import type { TerminalHandle } from "../driver/types";
import { assignSecrets, createGlobalSecret, createWorkerSecret, deleteSecret, injectSecrets, listGlobalSecrets, workerSecretView } from "../core/secrets";
import { createWorker, destroyWorker, getWorker, refFor, workersWithLiveState } from "../core/workers";
import { syncStatus, syncWorker } from "../core/sync";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const err = (e: unknown, status = 400) => json({ error: String(e instanceof Error ? e.message : e) }, status);

type TermConn = { workerId: string; cols: number; rows: number; term?: TerminalHandle };

export function startServer() {
  const driver = getDriver();

  const server = Bun.serve<TermConn>({
    port: config.port,
    hostname: config.host,
    idleTimeout: 120,
    async fetch(req, server) {
      const url = new URL(req.url);
      const p = url.pathname;

      // terminal websocket: /workers/:id/term?cols=N&rows=N
      const termMatch = p.match(/^\/workers\/([\w-]+)\/term$/);
      if (termMatch) {
        const cols = Math.max(2, Number(url.searchParams.get("cols")) || 80);
        const rows = Math.max(2, Number(url.searchParams.get("rows")) || 24);
        if (server.upgrade(req, { data: { workerId: termMatch[1], cols, rows } })) return;
        return new Response("upgrade failed", { status: 400 });
      }

      try {
        if (p === "/api/workers" && req.method === "GET") {
          return json(await workersWithLiveState());
        }
        if (p === "/api/workers" && req.method === "POST") {
          const b = await req.json();
          return json(await createWorker({
            name: b.name, sourcePath: b.sourcePath, apps: b.apps, secretIds: b.secretIds,
          }), 201);
        }
        let m = p.match(/^\/api\/workers\/([\w-]+)$/);
        if (m && req.method === "DELETE") {
          await destroyWorker(m[1]);
          return json({ ok: true });
        }
        m = p.match(/^\/api\/workers\/([\w-]+)\/secrets$/);
        if (m && req.method === "GET") return json(workerSecretView(m[1]));
        if (m && req.method === "PUT") {          // assign globals
          const b = await req.json();
          assignSecrets(m[1], b.secretIds ?? []);
          await injectSecrets(m[1]);
          return json(workerSecretView(m[1]));
        }
        if (m && req.method === "POST") {         // create VM-specific secret
          const b = await req.json();
          const s = createWorkerSecret(m[1], b.name, b.value);
          try {
            await injectSecrets(m[1]);
          } catch (e) {
            await deleteSecret(s.id);             // keep create+inject atomic
            throw e;
          }
          return json(workerSecretView(m[1]), 201);
        }
        m = p.match(/^\/api\/workers\/([\w-]+)\/sync$/);
        if (m && req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          return json(await syncWorker(m[1], { autocommit: b.autocommit ?? true }));
        }
        m = p.match(/^\/api\/workers\/([\w-]+)\/sync\/status$/);
        if (m && req.method === "GET") return json(await syncStatus(m[1]));

        // folder picker: list subdirectories of a host path
        if (p === "/api/fs/dirs" && req.method === "GET") {
          const raw = url.searchParams.get("path") || homedir();
          const path = resolve(raw);
          if (!existsSync(path) || !statSync(path).isDirectory()) {
            return err(`not a directory: ${path}`, 400);
          }
          const dirs = readdirSync(path, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith("."))
            .map((e) => ({
              name: e.name,
              isGitRepo: existsSync(join(path, e.name, ".git")),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
          return json({
            path,
            parent: dirname(path) !== path ? dirname(path) : null,
            isGitRepo: existsSync(join(path, ".git")),
            home: homedir(),
            dirs,
          });
        }

        if (p === "/api/secrets" && req.method === "GET") return json(listGlobalSecrets());
        if (p === "/api/secrets" && req.method === "POST") {
          const b = await req.json();
          return json(createGlobalSecret(b.name, b.value), 201);
        }
        m = p.match(/^\/api\/secrets\/([\w-]+)$/);
        if (m && req.method === "DELETE") {
          await deleteSecret(m[1]);
          return json({ ok: true });
        }
      } catch (e) {
        return err(e);
      }

      const s = staticRoutes[p];
      if (s) return new Response(Bun.file(s[0]), { headers: { "content-type": s[1] } });
      return new Response("not found", { status: 404 });
    },

    websocket: {
      open(ws) {
        const w = getWorker(ws.data.workerId);
        if (!w) { ws.close(4004, "worker not found"); return; }
        const term = driver.terminal(
          refFor(w.name),
          ["tmux", "new-session", "-A", "-s", config.tmuxSession],
          { cols: ws.data.cols, rows: ws.data.rows },
        );
        term.onData((chunk) => ws.send(chunk));
        term.onExit(() => { try { ws.close(1000, "terminal closed"); } catch {} });
        ws.data.term = term;
      },
      message(ws, msg) {
        const term = ws.data.term;
        if (!term) return;
        if (typeof msg === "string") {
          try {
            const ctl = JSON.parse(msg);
            if (ctl.type === "resize") term.resize(ctl.cols, ctl.rows);
          } catch {}
          return;
        }
        term.write(msg);
      },
      close(ws) {
        ws.data.term?.kill(); // detaches this client; tmux session lives on in the VM
      },
    },
  });

  console.log(`sadbox supervisor: http://localhost:${server.port}`);
  return server;
}
