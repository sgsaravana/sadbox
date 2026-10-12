import { join, resolve, dirname } from "path";
import { homedir } from "os";
import { existsSync, readdirSync, statSync } from "fs";
import { config } from "../config";
import { staticRoutes, aceFiles } from "../assets";
import { getDriver } from "../driver";
import type { TerminalHandle } from "../driver/types";
import { assignSecrets, createGlobalSecret, createProjectSecret, deleteSecret, injectSecrets, listGlobalSecrets, projectSecretView } from "../core/secrets";
import { createProject, destroyProject, getProject, projectDetails, refFor, projectsWithLiveState, rebuildProject } from "../core/projects";
import { syncStatus, syncProject } from "../core/sync";
import { terminalLinks } from "../core/links";
import { getSettings, updateSettings } from "../core/settings";
import { baseImageToolchain } from "../core/toolchain";
import { createRule, deleteRule, listRules, createHeaderRule, deleteHeaderRule, listHeaderRules } from "../net/rules";
import { resolveApproval, listPending, pendingCounts } from "../net/approvals";
import { recentRequests, subscribe } from "../net/events";
import { caCertPem } from "../net/ca";
import { createForward, deleteForward, listForwards } from "../net/forwards";
import { AuthError, authEnabled, clearCookie, crossOrigin, login, logout, safeNext, sessionCookie, signedIn, tokenFrom } from "../core/auth";
import { FileError, deletePath, fileIndex, listDir, makeDir, readFile, renamePath, writeFile } from "../core/files";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const err = (e: unknown, status = 400) => json({ error: String(e instanceof Error ? e.message : e) }, status);

/** Server-sent events feed for one project's live network activity. Pushes a
 *  snapshot on connect, then request/pending/resolved events as they happen. */
function netStream(projectId: string): Response {
  const enc = new TextEncoder();
  let unsub = () => {};
  let hb: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = (obj: unknown) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {}
      };
      send({
        type: "snapshot",
        requests: recentRequests(projectId),
        pending: listPending(projectId),
        rules: listRules(projectId),
        headerRules: listHeaderRules(projectId),
      });
      unsub = subscribe(projectId, send);
      hb = setInterval(() => { try { controller.enqueue(enc.encode(": ping\n\n")); } catch {} }, 25_000);
    },
    cancel() { unsub(); if (hb) clearInterval(hb); },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

type TermConn = { projectId: string; cols: number; rows: number; term?: TerminalHandle };

export function startServer() {
  const driver = getDriver();

  const server = Bun.serve<TermConn>({
    port: config.port,
    hostname: config.host,
    idleTimeout: 120,
    async fetch(req, server) {
      const url = new URL(req.url);
      const p = url.pathname;

      const termMatch = p.match(/^\/projects\/([\w-]+)\/term$/);

      // Another site's page must never drive this API or open a terminal, even
      // when sign-in is off: browsers attach an Origin to exactly these requests.
      if ((termMatch || !["GET", "HEAD", "OPTIONS"].includes(req.method)) && crossOrigin(req)) {
        return json({ error: "cross-origin request refused" }, 403);
      }

      // --- sign-in ---
      if (p === "/api/auth/login" && req.method === "POST") {
        try {
          const b = await req.json().catch(() => ({}));
          const token = await login(b.password);
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json", "set-cookie": sessionCookie(req, token) },
          });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof AuthError ? e.status : 400);
        }
      }
      if (p === "/api/auth/logout" && req.method === "POST") {
        logout(tokenFrom(req));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", "set-cookie": clearCookie() },
        });
      }
      if (p === "/api/auth/status" && req.method === "GET") {
        return json({ enabled: authEnabled(), signedIn: signedIn(req) });
      }
      // Everything else needs a session, except the login page and the static
      // script/style/vendor files (which are just this public repo's assets).
      const page = p === "/" || p === "/terminal" || p === "/editor";
      const needsSession = page || termMatch != null || p.startsWith("/api/");
      if (needsSession && !signedIn(req)) {
        if (page) {
          return new Response(null, { status: 302, headers: { location: `/login?next=${encodeURIComponent(p + url.search)}` } });
        }
        return json({ error: "not signed in" }, 401);
      }
      if (p === "/login" && signedIn(req)) {
        return new Response(null, { status: 302, headers: { location: safeNext(url.searchParams.get("next")) } });
      }

      // terminal websocket: /projects/:id/term?cols=N&rows=N
      if (termMatch) {
        const cols = Math.max(2, Number(url.searchParams.get("cols")) || 80);
        const rows = Math.max(2, Number(url.searchParams.get("rows")) || 24);
        if (server.upgrade(req, { data: { projectId: termMatch[1], cols, rows } })) return;
        return new Response("upgrade failed", { status: 400 });
      }

      try {
        if (p === "/api/projects" && req.method === "GET") {
          return json(await projectsWithLiveState());
        }
        if (p === "/api/projects" && req.method === "POST") {
          const b = await req.json();
          const git = b.git?.remote
            ? { remote: String(b.git.remote).trim(), token: b.git.token ? String(b.git.token) : undefined }
            : undefined;
          return json(await createProject({
            name: b.name,
            sourcePath: (b.sourcePath && String(b.sourcePath).trim()) || undefined, // empty ⇒ clone mode
            apps: b.apps, secretIds: b.secretIds, git,
          }), 201);
        }
        let m = p.match(/^\/api\/projects\/([\w-]+)$/);
        if (m && req.method === "DELETE") {
          await destroyProject(m[1]);
          return json({ ok: true });
        }
        m = p.match(/^\/api\/projects\/([\w-]+)\/details$/);
        if (m && req.method === "GET") return json(await projectDetails(m[1]));
        m = p.match(/^\/api\/projects\/([\w-]+)\/secrets$/);
        if (m && req.method === "GET") return json(projectSecretView(m[1]));
        if (m && req.method === "PUT") {          // assign globals
          const b = await req.json();
          assignSecrets(m[1], b.secretIds ?? []);
          await injectSecrets(m[1]);
          return json(projectSecretView(m[1]));
        }
        if (m && req.method === "POST") {         // create project-specific secret
          const b = await req.json();
          const s = createProjectSecret(m[1], b.name, b.value);
          try {
            await injectSecrets(m[1]);
          } catch (e) {
            await deleteSecret(s.id);             // keep create+inject atomic
            throw e;
          }
          return json(projectSecretView(m[1]), 201);
        }
        m = p.match(/^\/api\/projects\/([\w-]+)\/sync$/);
        if (m && req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          return json(await syncProject(m[1], { autocommit: b.autocommit ?? true }));
        }
        m = p.match(/^\/api\/projects\/([\w-]+)\/term\/links$/);
        if (m && req.method === "GET") return json(await terminalLinks(m[1]));
        m = p.match(/^\/api\/projects\/([\w-]+)\/rebuild$/);
        if (m && req.method === "POST") return json(await rebuildProject(m[1]));
        m = p.match(/^\/api\/projects\/([\w-]+)\/sync\/status$/);
        if (m && req.method === "GET") return json(await syncStatus(m[1]));

        // --- per-project network proxy: live feed, approvals, rules, headers ---
        m = p.match(/^\/api\/projects\/([\w-]+)\/net\/stream$/);
        if (m && req.method === "GET") return netStream(m[1]);
        m = p.match(/^\/api\/projects\/([\w-]+)\/net\/requests$/);
        if (m && req.method === "GET") return json({ requests: recentRequests(m[1]), pending: listPending(m[1]) });
        m = p.match(/^\/api\/projects\/([\w-]+)\/net\/approvals\/([\w-]+)$/);
        if (m && req.method === "POST") {
          const b = await req.json();
          return json({ ok: resolveApproval(m[2], b.action === "block" ? "block" : "allow", b.duration) });
        }
        m = p.match(/^\/api\/projects\/([\w-]+)\/net\/rules$/);
        if (m && req.method === "GET") return json(listRules(m[1]));
        if (m && req.method === "POST") {
          const b = await req.json();
          return json(createRule({ scope: "project", projectId: m[1], action: b.action, host: b.host, path: b.path, method: b.method, note: b.note }), 201);
        }
        m = p.match(/^\/api\/projects\/([\w-]+)\/net\/rules\/([\w-]+)$/);
        if (m && req.method === "DELETE") { deleteRule(m[2]); return json({ ok: true }); }
        m = p.match(/^\/api\/projects\/([\w-]+)\/net\/headers$/);
        if (m && req.method === "GET") return json(listHeaderRules(m[1]));
        if (m && req.method === "POST") {
          const b = await req.json();
          return json(createHeaderRule({ scope: "project", projectId: m[1], host: b.host, direction: b.direction, op: b.op, header: b.header, value: b.value, valueSecretId: b.valueSecretId }), 201);
        }
        m = p.match(/^\/api\/projects\/([\w-]+)\/net\/headers\/([\w-]+)$/);
        if (m && req.method === "DELETE") { deleteHeaderRule(m[2]); return json({ ok: true }); }

        // --- workdir files, for the browser editor (paths relative to the workdir) ---
        m = p.match(/^\/api\/projects\/([\w-]+)\/files$/);
        if (m && req.method === "GET") return json(await listDir(m[1], url.searchParams.get("path") ?? ""));
        if (m && req.method === "POST") {           // new folder
          const b = await req.json();
          return json(await makeDir(m[1], b.path), 201);
        }
        m = p.match(/^\/api\/projects\/([\w-]+)\/files\/index$/);
        if (m && req.method === "GET") return json(await fileIndex(m[1]));
        m = p.match(/^\/api\/projects\/([\w-]+)\/files\/rename$/);
        if (m && req.method === "POST") {
          const b = await req.json();
          return json(await renamePath(m[1], b.from, b.to));
        }
        m = p.match(/^\/api\/projects\/([\w-]+)\/file$/);
        if (m && req.method === "GET") return json(await readFile(m[1], url.searchParams.get("path")));
        if (m && req.method === "PUT") {            // save (baseHash guards against clobbering the agent's edits)
          const b = await req.json();
          return json(await writeFile(m[1], b.path, b.content, { baseHash: b.baseHash, force: b.force === true }));
        }
        if (m && req.method === "DELETE") return json(await deletePath(m[1], url.searchParams.get("path")));

        // --- per-project port forwards (host port → VM port) ---
        m = p.match(/^\/api\/projects\/([\w-]+)\/forwards$/);
        if (m && req.method === "GET") return json({ host: config.forwardHost, forwards: listForwards(m[1]) });
        if (m && req.method === "POST") {
          const b = await req.json();
          return json(await createForward(m[1], { hostPort: b.hostPort, guestPort: b.guestPort }), 201);
        }
        m = p.match(/^\/api\/projects\/([\w-]+)\/forwards\/([\w-]+)$/);
        if (m && req.method === "DELETE") { deleteForward(m[1], m[2]); return json({ ok: true }); }

        // --- global network rules + shared proxy endpoints ---
        if (p === "/api/net/rules" && req.method === "GET") return json(listRules());
        if (p === "/api/net/rules" && req.method === "POST") {
          const b = await req.json();
          return json(createRule({ scope: "global", action: b.action, host: b.host, path: b.path, method: b.method, note: b.note }), 201);
        }
        m = p.match(/^\/api\/net\/rules\/([\w-]+)$/);
        if (m && req.method === "DELETE") { deleteRule(m[1]); return json({ ok: true }); }
        if (p === "/api/net/headers" && req.method === "GET") return json(listHeaderRules());
        if (p === "/api/net/headers" && req.method === "POST") {
          const b = await req.json();
          return json(createHeaderRule({ scope: "global", host: b.host, direction: b.direction, op: b.op, header: b.header, value: b.value, valueSecretId: b.valueSecretId }), 201);
        }
        m = p.match(/^\/api\/net\/headers\/([\w-]+)$/);
        if (m && req.method === "DELETE") { deleteHeaderRule(m[1]); return json({ ok: true }); }
        if (p === "/api/net/pending" && req.method === "GET") return json(pendingCounts());
        if (p === "/api/net/ca" && req.method === "GET") {
          return new Response(caCertPem() || "", {
            headers: { "content-type": "application/x-pem-file", "content-disposition": "attachment; filename=sadbox-proxy-ca.crt" },
          });
        }

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

        // toolchain baked into the image new projects boot from (name + version)
        if (p === "/api/toolchain" && req.method === "GET") {
          return json(await baseImageToolchain(url.searchParams.get("refresh") === "1"));
        }

        if (p === "/api/settings" && req.method === "GET") return json(getSettings());
        if (p === "/api/settings" && req.method === "PUT") {
          const b = await req.json();
          return json(updateSettings({
            defaultCpus: b.defaultCpus, defaultMemoryMB: b.defaultMemoryMB, defaultDiskGB: b.defaultDiskGB,
          }));
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
        if (e instanceof FileError) return json({ error: e.message, ...e.extra }, e.status);
        return err(e);
      }

      if (p.startsWith("/vendor/ace/")) {
        const f = aceFiles[p.slice("/vendor/ace/".length)];
        if (f) return new Response(Bun.file(f), { headers: { "content-type": "text/javascript", "cache-control": "max-age=3600" } });
      }
      if (p === "/api/editor/modes") {
        return json(Object.keys(aceFiles).filter((f) => f.startsWith("mode-")).map((f) => f.slice(5, -3)));
      }
      const s = staticRoutes[p];
      if (s) return new Response(Bun.file(s[0]), { headers: { "content-type": s[1] } });
      return new Response("not found", { status: 404 });
    },

    websocket: {
      open(ws) {
        const proj = getProject(ws.data.projectId);
        if (!proj) { ws.close(4004, "project not found"); return; }
        // -A: attach to the existing session (create it only if missing) — never
        // a second session. -D: detach any other client on attach, so orphaned
        // clients (e.g. a browser tab closed without a clean detach) don't pile
        // up mirroring the same session and fighting over its size.
        const term = driver.terminal(
          refFor(proj.name),
          // -c: if the session has to be created here (the last shell was exited,
          // or the VM was restarted), start it in the workdir like the original
          ["tmux", "new-session", "-A", "-D", "-s", config.tmuxSession, "-c", config.guestWorkdir],
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
