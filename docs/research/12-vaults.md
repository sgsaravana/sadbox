# Vaults — variables and secrets a VM can use but not read

> **Status: planned 2026-11-03** (agreed with the owner, not built yet). Replaces
> the Secrets tab. Builds on the credential proxy (`11-credential-proxy.md`) and
> the network approvals (`10-network-proxy.md`). Build order at the end.
> Spike F (2026-11-03/04, `spikes/f-agent-sessions/`): body swapping (V3)
> works with real clients (F.4); the proxy already refuses the supervisor's own
> address (V8, still to get a test).

## The brief

1. Create **variables** or **secrets**, typed **string / number / json**.
   Variables are visible in the list; secrets are encrypted and hidden, but can
   be revealed in the UI with an eye icon.
2. Choose, per item, **which projects** can access it.
3. The VMs must **never be able to read** an item — only refer to it and use it.

## What exists today

Secrets are global (assignable to many projects) or project-specific, with two
deliveries (`src/core/secrets.ts`):

- `env` — the real value is written to `~/.sadbox/env` in the VM. Readable.
- `proxy` — the VM gets a placeholder; the MITM proxy swaps in the real value
  in **request headers** on https to hosts the secret is bound to, and swaps it
  back to the placeholder in response headers (`src/net/credentials.ts`).

Values are write-only in the API: nothing returns a decrypted value.

## The limit that shaped the design

"Usable but never readable" only exists for a value that leaves the VM inside a
request the proxy can see — an HTTPS call to an API. A value a program uses
**locally** cannot be hidden from that program: a port number or feature flag
read by code, a database password sent over a raw TCP protocol (Postgres,
Redis), a key that signs something inside the VM (JWT/HMAC, AWS SigV4 — the
AWS SDK signs requests locally, so a placeholder access key cannot work).
Anything a process can use locally, it can read.

The owner's reference point was **AWS Secrets Manager**: apps refer to a secret
and fetch it at runtime. That model does hand the real value to the app — what
it guarantees is that the value is not in code, config, env or on disk, that
only authorised principals can fetch it, and that every fetch is audited. In a
sadbox VM the AI agent runs alongside the app, so whatever the app can fetch,
the agent can too; an approval step is what keeps the agent from doing it
quietly.

## Decisions

| # | Decision | Why |
|---|---|---|
| V1 | **One vault list** replaces global + project-specific secrets. Each item: name, kind (`variable` / `secret`), type (`string` / `number` / `json`), value (encrypted at rest for both kinds), the projects that may use it, the hosts it may be sent to. | One place to manage everything; access is a property of the item. |
| V2 | **Two modes, chosen per item:** **proxy** (never readable) and **fetch at runtime** (Secrets-Manager style). | Proxy covers HTTP API keys with the strongest guarantee; fetch covers the values a program must use locally, which no placeholder can. |
| V3 | **Proxy mode** = today's placeholder delivery, extended: swapping in the URL and request body (JSON / form / text, size-capped) besides headers. Typed: in a JSON body a `number` / `json` item is written as a raw value (`"limit": "sbx_…"` → `"limit": 50`). Real values coming back are redacted to the placeholder in response headers **and bodies**. | Many APIs take credentials in the query or body; types make non-string values usable. |
| V4 | Proxy swapping is **headers-only by default**; URL / body swapping is an opt-in per item. | Exfiltration risk: a bound host that stores and echoes data (a gist, an issue comment) could receive a swapped value in a body and serve it back. Narrow by default, with response redaction as a second line. |
| V5 | **Fetch at runtime**: inside the VM, `sadbox-vault get NAME` or `http://vault.sadbox.internal/v1/NAME`, served by the supervisor over the VM's existing proxy channel. Only projects ticked for the item get an answer; every read is logged (project, item, time). Nothing is written to env or disk. | The Secrets Manager model, adapted to a VM with no network of its own. |
| V6 | **Approvals for fetches:** a **secret's** first fetch from a project waits for the owner's answer — once / 1 h / always, like network approvals. **Variables** are served without asking. Every read is logged either way. | Stops the agent from silently reading secrets; variables are not sensitive by definition. |
| V7 | **Reveal in the UI:** variables show their value in the list; secrets show `••••` and an eye icon that fetches the value on demand. Each reveal is logged. Values become editable. | Brief item 1. This is the first API that returns decrypted values: it sits behind the sign-in, and the VM must be unable to reach it (V8). |
| V8 | **The VM can never reach the supervisor's own API** through the proxy — verified, with a test. | Otherwise the reveal endpoint (V7) would undo everything. |
| V9 | **Migration:** existing `proxy` secrets → proxy items, bindings kept. Existing `env` secrets → **fetch** items **without** approval, and they keep being written to the env file until the owner turns that off per item, so nothing using them breaks. Global assignments become the item's projects; a project-specific secret gets access to its one project. | Owner's choice: keep existing secrets working, tighten item by item. |

## Not decided yet / open

- Placeholder format for `number` / `json` items in env (a placeholder is a
  string; only proxy-side rendering makes it typed).
- Body size cap and which content types get body swapping / redaction.
- Whether the read log gets its own view or joins the project's events.

## Build steps (Vaults)

1. Data model (`vault_items`, `vault_access`; bindings and placeholders
   reused), migration from `secrets`, API, tests.
2. **Vaults** tab: types, eye reveal, edit, per-project access (from the item
   and from the project page).
3. Proxy delivery: URL + body swapping with types, response body redaction,
   VM → supervisor API blocked (V8). Tests.
4. Fetch at runtime: the in-VM endpoint and `sadbox-vault` CLI, read log,
   approvals.

Agent logins and history are the other half of the same request:
[13-agent-sessions.md](13-agent-sessions.md). The two halves do not depend on
each other.
