# Spike G — named routes for port forwards

Prototype for [`docs/research/17-named-routes.md`](../../docs/research/17-named-routes.md):
one HTTP gateway maps a *name* to an app port, either as a path prefix
(`/p/sample/…`) or as a host (`sample.sadbox.test`).

## Files

| File | What it is |
|---|---|
| `router.ts` | The gateway. Prefix strip, `X-Forwarded-*`, `Location`/`Set-Cookie` rewriting, WebSocket pass-through, optional `<base>` injection and `stripPrefix=false`. |
| `app.ts` | A mock app that uses root-absolute assets, relative links, host-derived absolute URLs, redirects, cookies and a WebSocket. |
| `test.ts` | Runs both modes and prints the observed results. |

## Run

```sh
bun test.ts
```

The test uses ports 15700–15711. Expected output is in the research doc;
`all checks passed` means the router behaved as designed (the two ❌-worthy
observations — root-absolute URLs and host-derived absolute URLs — are
recorded as informative checks, not router bugs).

## Caddy check

Caddy 2.11.9 was run with `auto_https off` (HTTP only, to isolate routing):

```caddy
:15900 {
  handle /p/* {
    reverse_proxy 127.0.0.1:15810
  }
  handle {
    respond "sadbox UI" 200
  }
}

:15901 {
  reverse_proxy 127.0.0.1:15811   # host-mode router
}

:15902 {
  handle_path /q/* {
    reverse_proxy 127.0.0.1:15701   # mock app, Caddy strips the prefix
  }
}
```

Observations:

- `GET :15900/p/sample/echo` → `{"path":"/echo","forwardedPrefix":"/p/sample"}`.
- `GET :15900/api/whatever` → the UI fallback, not the app.
- `Host: sample.sadbox.test` on `:15901/echo` → routed to the app, path `/echo`.
- WebSocket echo worked through both Caddy shapes.
- `handle_path` at `:15902/q/go` returned `Location: /after` **without** the
  `/q` prefix; `:15902/q/` still served `src="/app.js"`. Caddy strips the
  prefix but does not rewrite responses, so a path route cannot be made
  transparent with Caddy alone.

## Vite check

A minimal Vite 6 app, served through the path gateway:

| Vite base | Gateway | Page | `/p/sample/src/main.js` | Verdict |
|---|---|---|---|---|
| `/` (default) | strip prefix | 200, refs `/src/main.js` | 404 | broken |
| `/` (default) | keep prefix | 200 (SPA fallback) | 200 `text/html` | broken |
| `/p/sample/` | strip prefix | 302 | 404 | broken |
| `/p/sample/` | keep prefix | 200 | 200 `text/javascript` | works |

Only an app configured with the exact public base path, forwarded without
stripping, works. This is the central finding: a path prefix is a deployment
mode the app must know about.
