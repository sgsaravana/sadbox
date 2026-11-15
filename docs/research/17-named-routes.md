# Named routes for port forwards — feasibility study

> **Question:** can a port inside a project VM be published as a *name* on the
> same domain as sadbox (for example `sadbox.domain.com/sample` → VM port
> 3030), instead of a separate host port that a reverse proxy does not route?
>
> **Verdict:** the *gateway* is feasible and simple. Publishing arbitrary apps
> under a **path on the same origin as the web UI is not** — it breaks most
> apps and creates a serious same-origin security problem. Named **host**
> routes (`sample.sadbox.domain.com`) are the robust version of the same idea.
> Path routes are only usable for apps that are explicitly configured for a
> base path, and should live on a separate app hostname.
>
> Tested 2026-11-15 with Bun 1.4.4, Caddy 2.11.9 and Vite 6.4.6. The prototype
> is in [`spikes/g-named-routes/`](../../spikes/g-named-routes/).

## 1. Why the current setup fails behind Caddy

Today a forward is a real listening socket on the host (`host_port`), and the
browser is expected to open `<host>:<port>` directly:

- `src/net/forwards.ts` binds `config.forwardHost:host_port` and serves plain
  HTTP (sign-in gate) or raw TCP.
- `src/config.ts` says it plainly: forwards are plain HTTP/TCP, not behind a
  reverse proxy's TLS.
- `packaging/caddy/Caddyfile.example` routes **only 7070** and says "Only port
  7070 is routed".

So when Caddy terminates TLS for `sadbox.domain.com` → `127.0.0.1:7070`, the
forward on `3030` is a different socket that Caddy never sees. There are two
ways out:

1. **Expose every forward port through Caddy** (a site block per port, TLS on
   each port, config reload per route), or
2. **Route everything through one HTTP gateway** that dispatches by name —
   the subject of this study.

Option 2 is attractive because it needs one Caddy rule and gives one TLS
origin, but the URL shape determines whether apps actually work.

## 2. What was prototyped

[`spikes/g-named-routes/router.ts`](../../spikes/g-named-routes/router.ts) is a
small gateway that maps a name to an upstream port in two modes:

```
path:  /p/sample/...          →  127.0.0.1:3030   (prefix stripped, unless stripPrefix=false)
host:  sample.sadbox.test/... →  127.0.0.1:3030   (path unchanged)
```

It does what a production gateway would need: prefix stripping,
`X-Forwarded-*`, `Location` rewriting, `Set-Cookie` path scoping, WebSocket
pass-through, 404 for unknown names, and canonical trailing-slash redirects.
[`app.ts`](../../spikes/g-named-routes/app.ts) is a mock app that uses the same
patterns real frameworks use: root-absolute assets, relative links,
host-derived absolute URLs, redirects, cookies and a WebSocket.
[`test.ts`](../../spikes/g-named-routes/test.ts) runs both modes.

## 3. Measured results: the gateway mechanics work

`bun run test.ts` in the spike:

| Check | Path `/p/sample/…` | Host `sample.sadbox.test` |
|---|---|---|
| Prefix stripped before the app | ✅ `/echo` | ✅ (nothing to strip) |
| `X-Forwarded-Prefix` | ✅ `/p/sample` | ✅ none |
| Missing trailing slash | ✅ 308 → `/p/sample/` | n/a |
| Unknown name | ✅ 404 | ✅ 404 |
| `Location: /after` rewritten | ✅ `/p/sample/after` | ✅ unchanged |
| `Set-Cookie: Path=/` scoped | ✅ `Path=/p/sample` | ✅ `Path=/` |
| WebSocket carried, path stripped | ✅ `echo:ping` | ✅ `echo:ping` |
| Two names reach two different apps | ✅ | ✅ |

Caddy was then run in front of the same gateway. Both shapes worked end to
end, including WebSockets:

| Caddy config | Result |
|---|---|
| `handle /p/* { reverse_proxy 127.0.0.1:15810 }` | ✅ page, redirect, WebSocket |
| `reverse_proxy 127.0.0.1:15811` (Host `sample.sadbox.test`) | ✅ page, WebSocket |
| `handle_path /q/* { reverse_proxy … }` | ❌ Caddy strips the prefix but **does not** rewrite `Location: /after`; root-absolute assets still point at `/` |

So there is no routing/PROXY/WebSocket blocker. The problem is what the app
does with absolute URLs, and what sharing an origin does to security.

## 4. Where path routing breaks: absolute URLs

The same test output that shows the gateway working also shows the failures
that no proxy can fix generically. The mock app's page contains both link
styles:

```html
<link rel="stylesheet" href="/style.css">   <!-- root-absolute -->
<script type="module" src="/app.js">         <!-- root-absolute -->
<a href="relative">relative</a>              <!-- relative -->
<a href="/absolute">absolute</a>
```

At `/p/sample/` the browser resolves those to:

| In the document | Browser requests | Through the gateway | Result |
|---|---|---|---|
| `href="relative"` | `/p/sample/relative` | stripped to `/relative` | ✅ |
| `href="/absolute"` | `/absolute` | sadbox UI, not the app | ❌ 404/wrong app |
| `src="/app.js"` | `/app.js` | sadbox UI | ❌ |
| `fetch("/api/data")` in JS | `/api/data` | sadbox UI | ❌ |
| `new WebSocket("/ws")` in JS | `/ws` | sadbox UI | ❌ |

Injecting `<base href="/p/sample/">` fixes only relative URLs; it does not
change root-absolute ones (verified in the spike). Rewriting the HTML body is
not a real fix either: it must decode compression, break streaming, handle
CSS `url()`, JS string literals, source maps and dynamically built URLs — and
it still cannot reliably rewrite JavaScript. A service-worker shim was
considered and rejected: it cannot intercept WebSockets, only activates after
the first page load, and adds behaviour that is very hard to debug.

The app can also generate absolute URLs from the request host:

```
GET /p/sample/absurl
→ <a href="http://sadbox.domain.com/absolute">   ← prefix missing
```

Browsers, OAuth callbacks, cookie domains, `Origin` checks and email links all
tend to use the absolute form. A path prefix is a deployment mode the app
must know about; it cannot be made transparent from outside.

### Real-framework check (Vite 6)

A minimal Vite app was served through the gateway in all four combinations:

| App config | Gateway | Page | Asset | Verdict |
|---|---|---|---|---|
| default `base: "/"` | strip prefix | 200, HTML says `/src/main.js` | `/src/main.js` → 404 | ❌ |
| default `base: "/"` | keep prefix | 200 (SPA fallback) | `/p/sample/src/main.js` → 200 **HTML**, wrong type | ❌ |
| `base: "/p/sample/"` | strip prefix | 302 | 404 | ❌ |
| `base: "/p/sample/"` | keep prefix | 200 | 200 `text/javascript` | ✅ |

Only the last combination works, and it requires **both** the app to be
configured with the exact public prefix **and** the gateway not to strip it.
A root-only app and a base-aware app therefore need opposite proxy behaviour.
There is no universal setting.

Most frameworks can be configured this way — Next.js `basePath`, Vite `base`,
SvelteKit `paths.base`, Astro `base`, Django `FORCE_SCRIPT_NAME`, Rails
`RAILS_RELATIVE_URL_ROOT`, CRA `PUBLIC_URL` — but sadbox cannot know the
framework, cannot set it for an app the agent started, and the user has to
get it exactly right. Apps with hard-coded `/` paths cannot be fixed at all.

## 5. The security blocker: same origin as the web UI

This is more serious than the broken assets. If a route is served at
`sadbox.domain.com/sample`, the app's JavaScript runs on the **same origin** as
the sadbox UI. The user's session cookie is `Path=/`, `SameSite=Strict`,
`HttpOnly` — it is sent to every same-origin request, including requests the
app's JavaScript makes. `crossOrigin()` in `src/core/auth.ts` compares the
`Origin` host with the request host; a same-origin request passes.

So the app in the VM can call, with the operator's session:

- `GET /api/vault/:id/value` (reveal secrets),
- `POST /api/projects` / `DELETE /api/projects/:id` (create/destroy VMs),
- the terminal WebSocket, the file API, the proxy rules — everything.

The current per-port forward deliberately avoids this: a different port is a
different origin, and the gate strips all `sadbox_*` cookies before forwarding
(`isSadboxCookie` / `appCookies` in `src/net/forwards.ts`). Path routing on the
UI host removes that boundary. The app does not need to read the cookie; the
browser attaches it automatically.

Mitigations, in order of strength:

1. **Use a separate hostname for app routes** (e.g.
   `apps.sadbox.domain.com/sample`, or `<name>.sadbox.domain.com`). That
   restores the origin boundary. It also stops localStorage, IndexedDB,
   cookies and service-worker registrations from colliding with the UI and
   with other apps.
2. Do not offer same-origin path routes at all. This is the recommendation.
3. Put the app in an iframe with a different origin — still needs a different
   origin; not a fix by itself.

Same-origin path routing also shares cookies and web storage between every
route: two apps named `sample` and `other` can read each other's
`localStorage`, and JS-set cookies (`document.cookie = "…; path=/"`) never pass
through the proxy, so the proxy cannot scope them. Service workers registered
at `/` collide with sadbox itself.

## 6. URL namespace: `/sample` is not free

The UI already owns `/`, `/login`, `/terminal`, `/editor`, `/forwards/*`,
`/projects/*`, `/api/*`, and static assets. A route named `api`, `login`,
`terminal`, `favicon.ico`, etc. would shadow the UI. More importantly, **Caddy
cannot route arbitrary future names** without a rule for each one:

- With a fixed prefix (`/r/sample`), one Caddy rule (`/r/*` → gateway) covers
  every present and future route. This is the only shape that scales without
  editing Caddy for each new route.
- With bare `/sample`, either every route needs a Caddy `handle` block (and a
  reload), or **all** traffic must go through the gateway, which then falls
  back to the UI. The latter is possible but adds a proxy hop to the UI, SSE
  and terminal WebSockets for no benefit.
- Keep a reserved-name list regardless: `api`, `login`, `logout`, `terminal`,
  `editor`, `forwards`, `projects`, `assets`, `static`, `favicon.ico`, `_next`,
  `__sadbox`, etc.

So the literal `sadbox.domain.com/sample` is possible, but the robust path URL
is `sadbox.domain.com/r/sample/` (or `apps.sadbox.domain.com/sample`).

## 7. Options compared

| Option | App compatibility | Security (UI origin) | Caddy / DNS setup | Verdict |
|---|---|---|---|---|
| **A. Path on the UI host** (`sadbox.domain.com/r/sample/`) | poor: root-absolute URLs, JS fetches/WS, base path required | **bad**: app can call the sadbox API as the user | one `/r/*` rule; no DNS change | ❌ no-go |
| **B. Path on an app host** (`apps.sadbox.domain.com/sample/`) | poor/conditional: same base-path work, but at least isolated | good: different origin | one host + rule; needs a DNS name/cert | ⚠️ opt-in only |
| **C. Named subdomain** (`sample.sadbox.domain.com`) | **excellent**: app runs at `/`, no changes | good: different origin | wildcard DNS + wildcard cert; one Caddy block | ✅ recommended |
| **D. Caddy site per port** (`sadbox.domain.com:3030`) | excellent | good | one Caddy block per forward, TLS per port, reload | ✅ interim, manual |
| **E. Rewrite HTML/JS/CSS responses** | never complete | same as A | one rule | ❌ fragile |
| **F. Service-worker prefix shim** | partial, no WS | same as A | one rule | ❌ rejected |

Option C is the same "named route" product feature, with the name in the host
instead of the path. It sidesteps every app-compatibility issue because the
app still sees `/`, and it keeps the security boundary. The price is a
wildcard DNS record and a wildcard certificate.

Option D is what works today with no sadbox changes: keep the UI on 7070 and
put a Caddy site block for each forwarded port. The forward must listen on
loopback (`SADBOX_FORWARD_HOST=localhost`) so Caddy can take the public port;
the sign-in ticket URL is currently hard-coded to `http://host:host_port`, so
either use an `open` forward or fix that link generation per route.

## 8. Recommendation

**Build named routes, but make the host the name.** Concretely:

1. **`<name>.sadbox.domain.com`** (or `<name>-<project>.sadbox.domain.com`) is
   the default URL for a named route. This is the only option that is
   transparent for arbitrary apps and safe for the sadbox session.
2. **Path routes are opt-in**, live on a separate app hostname
   (`apps.sadbox.domain.com/r/<name>/`), and carry a warning that the app must
   be started with a matching base path. Do not put them on the UI hostname.
3. Keep the existing port forwards for non-HTTP protocols and for people who
   do not want DNS changes.
4. Add a "copy URL" action that uses the public origin (forwarded host/proto),
   not `localhost:<port>`.

This still delivers the user-facing goal — "connect port 3030 to a name and
open it from the same sadbox domain" — with one DNS wildcard instead of a
per-port Caddy rule. It also means the same gateway can serve both shapes:
host-based by default, path-based for the explicit base-path case.

## 9. Implementation sketch (if approved)

### Data

New table (avoids making `port_forwards.host_port` nullable and its `UNIQUE`
constraint awkward):

```sql
CREATE TABLE named_routes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  guest_port  INTEGER NOT NULL,
  access      TEXT NOT NULL DEFAULT 'signin',   -- signin | open
  base_path   TEXT,                             -- NULL for host routes; '/r/sample' for path routes
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`base_path` non-null selects path mode. Names are validated as
`[a-z0-9][a-z0-9-]{0,62}`, lower-cased, and checked against the reserved list.
Route passes can reuse `forward_sessions` with the route id (it is just an
opaque id); cookies become `sadbox_route_<id>` scoped to `base_path`.

### Gateway

New `src/net/routes.ts`, started from `src/cli.ts` next to `startForwards()`:

- one `node:http` listener on `SADBOX_ROUTES_PORT` (default `7072`),
  `SADBOX_ROUTES_HOST=127.0.0.1` because Caddy is in front;
- resolve the route by `Host` first (host mode), then by path prefix
  (`/r/<name>/`), else 404;
- reuse the existing `gate()`/`bridge()` code: auth ticket, pass cookie,
  header filtering, unix-socket bridge into the VM — this is already written
  and tested in `src/net/forwards.ts`;
- for path routes: strip the prefix (or not, if `base_path` mode is
  "app-aware"), set `X-Forwarded-Prefix`, rewrite `Location` and
  `Set-Cookie: Path`, and carry `Upgrade` (WebSocket) with the rewritten path;
- refuse path routes whose public origin equals the UI origin (config check),
  so the same-origin mistake cannot be configured accidentally.

### Config

```
SADBOX_ROUTES_PORT=7072
SADBOX_ROUTES_HOST=127.0.0.1
SADBOX_ROUTE_DOMAIN=sadbox.domain.com   # host mode suffix; empty disables it
SADBOX_ROUTE_PATH_PREFIX=/r             # path mode namespace
```

### Caddy

Host mode (recommended):

```caddy
sadbox.domain.com, *.sadbox.domain.com {
	@ui host sadbox.domain.com
	handle @ui {
		reverse_proxy 127.0.0.1:7070 {
			flush_interval -1
		}
	}
	handle {
		reverse_proxy 127.0.0.1:7072
	}
}
```

The wildcard certificate needs the DNS challenge (`dns cloudflare …`), exactly
like the existing `packaging/caddy/Caddyfile.example` Option A.

Path mode (separate app host):

```caddy
sadbox.domain.com {
	reverse_proxy 127.0.0.1:7070 { flush_interval -1 }
}
apps.sadbox.domain.com {
	handle /r/* {
		reverse_proxy 127.0.0.1:7072
	}
	handle {
		respond "not a named route" 404
	}
}
```

Do **not** proxy routes on the UI host; that is the security and namespace
problem described above.

### UI / API

- `GET/POST /api/projects/:id/routes`, `PATCH/DELETE …/routes/:id`
  (`{name, guestPort, access}`), plus `GET /api/routes` if a global view is
  wanted.
- Detail view: a "Named route" section with name, VM port, access and a copy
  link. Show the resolved URL from `X-Forwarded-Host`/`SADBOX_ROUTE_DOMAIN`,
  never `localhost:<port>`.
- `/routes/:id/open` issues a ticket and redirects to the route's public URL,
  analogous to `/forwards/:id/open`.
- Validation errors: duplicate name, reserved name, name used by another
  project, same name as a project (if using `<project>.domain`), and path mode
  without a configured app base.

### Tests

Unit/integration in `src/net/routes.test.ts` (mirroring
`src/net/forwards.test.ts`): name validation and collisions; host/path
resolution; unknown route; sign-in ticket and cookie scope; `Location` and
`Set-Cookie` rewriting; WebSocket; path prefix strip vs keep; refusal of a
path route on the UI origin; restart persistence; project destroy cleanup.
The spike's mock app and harness can be lifted almost unchanged.

### Effort

| Piece | Estimate |
|---|---|
| Host-mode named routes (DB, gateway, auth, API, UI, docs, tests) | 2–3 dev-days |
| Path mode on a separate app host (prefix rewrite, base-path UX, warnings) | +2 dev-days |
| Same-origin path mode | **not planned** (no-go) |
| Caddy examples + deployment docs | 0.5 day |

A path-only MVP that ignores app base paths could be hacked in a day, but it
would break most real apps and should not be the default.

## 10. Open questions for the operator

1. **DNS/TLS:** can you add `*.sadbox.domain.com` (a wildcard A/CNAME) and a
   wildcard certificate? If you already use Cloudflare DNS with Caddy's DNS
   challenge, this is one record and one Caddy line. If not, path routes are
   the only same-domain option, with the caveats above.
2. **Trust:** are these apps trusted not to call sadbox's own API? If not,
   same-origin path routing is disqualified regardless of app compatibility.
3. **App shape:** are they mostly Vite/Next/static sites you control, or
   arbitrary agent-started apps? Base-path support is realistic for the
   former, not the latter.
4. **Non-HTTP:** do you need raw TCP (databases, SSH) by name? Path routing
   only works for HTTP; those stay as port forwards or get host/port routes.

## Appendix A — reproduce

```sh
cd spikes/g-named-routes
bun test.ts          # both modes against the mock app
```

The Vite and Caddy checks are described in
[`spikes/g-named-routes/README.md`](../../spikes/g-named-routes/README.md);
they need `vite` and a Caddy binary and are not part of the repo's test suite.

## Appendix B — raw spike output

```
== PATH MODE — /p/<name>/… ==
✅ prefix is stripped upstream  — upstream saw /echo
✅ X-Forwarded-Prefix is set  — /p/sample
✅ missing trailing slash redirects  — 308 → /p/sample/?x=1
✅ unknown name is 404  — 404
✅ Location is rewritten with the prefix  — /p/sample/after
✅ Set-Cookie Path is scoped  — sid=abc; Path=/p/sample; HttpOnly; SameSite=Lax
✅ WebSocket is carried, path stripped  — "echo:ping"
✅ HTML keeps root-absolute asset URLs (breaks in a browser)
✅ app-generated absolute URL loses the prefix
✅ two named routes reach two different apps
✅ <base href> makes relative links work
✅ <base href> does NOT fix root-absolute links

== HOST MODE — <name>.sadbox.test ==
✅ name comes from the Host header
✅ path is unchanged
✅ no prefix is injected
✅ Location is unchanged
✅ Set-Cookie Path=/ is unchanged
✅ root-absolute URLs are correct at the app root
✅ WebSocket is carried at /ws
✅ unknown host is 404
✅ two hosts reach two different apps
```
