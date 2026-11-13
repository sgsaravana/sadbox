const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) { // session ended — back to the login page, then return here
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
    return new Promise(() => {});
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
};

let vaultCache = [];    // every vault item (a variable with its value, a secret without)
let projectNames = {};  // id → name, for showing which projects use an item

// ---- side nav routing ----
// hashes: #projects (list) · #vaults · #project/<id> (detail)
let detailTimer = null;
let openCreateNext = false; // set by the Home CTA so #projects opens the create form
function route() {
  if (location.hash === "#secrets") { location.replace("#vaults"); return; } // the page's old name
  const hash = location.hash.slice(1);
  const [head, arg] = hash.split("/");
  clearInterval(detailTimer); detailTimer = null;
  if (!(head === "project" && arg)) closeNet();

  const detail = head === "project" && arg;
  const isProjects = head === "projects";
  const isVaults = head === "vaults";
  const isSettings = head === "settings";
  const isAgents = head === "agents";
  const isHome = !detail && !isProjects && !isVaults && !isSettings && !isAgents; // default / #home / unknown

  $("#view-home").hidden = !isHome;
  $("#view-projects").hidden = !isProjects;
  $("#view-vaults").hidden = !isVaults;
  $("#view-settings").hidden = !isSettings;
  $("#view-agents").hidden = !isAgents;
  $("#view-detail").hidden = !detail;

  const activeNav = isVaults ? "vaults" : isSettings ? "settings" : isAgents ? "agents"
    : (isProjects || detail) ? "projects" : "home";
  document.querySelectorAll(".nav-item").forEach((a) =>
    a.classList.toggle("active", a.dataset.view === activeNav));

  if (isVaults) refreshVault();
  else if (isAgents) refreshAgents();
  else if (isSettings) loadSettings();
  else if (detail) openDetail(arg);
  else if (isProjects) {
    refreshProjects();
    if (openCreateNext) { openCreateNext = false; openCreateForm(); } else closeCreateForm();
  }
  else if (isHome) refreshServiceStatus();
  refreshNavTree();
}
addEventListener("hashchange", route);
const showView = (v) => { location.hash = v; };

// ---- agents: logins sadbox keeps, history per project name ----
const TOOL_NAMES = { claude: "Claude Code", omp: "omp", opencode: "opencode" };
const agentWhen = (v) => {
  if (v == null) return "—";
  const d = typeof v === "number" ? new Date(v) : new Date(String(v).includes("T") ? v : v.replace(" ", "T") + "Z");
  return d.toLocaleString();
};
const inHours = (ms) => {
  const h = (ms - Date.now()) / 36e5;
  return h < 0 ? "expired" : h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`;
};
async function refreshAgents() {
  let a;
  try { a = await api("/api/agents"); } catch (e) {
    $("#agents-logins").innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return;
  }
  $("#agents-logins").innerHTML = a.logins.length ? a.logins.map((l) => `
    <div class="vitem-card">
      <div class="vrow">
        <span class="sec-name">${escapeHtml(TOOL_NAMES[l.tool] || l.tool)}</span>
        <span class="tbadge">${escapeHtml(l.provider)}</span>
        <span class="dbadge ${l.shared === "placeholders" ? "proxy" : "fetch"}">${l.shared === "placeholders" ? "kept by sadbox · placeholders in VMs" : "API key · copied into VMs"}</span>
        <span class="vactions">
          ${l.kind === "oauth" ? `<button type="button" class="mini" data-refresh-login>Refresh now</button>` : ""}
          <button type="button" class="mini danger" data-forget="${escapeHtml(l.tool)}/${escapeHtml(l.provider)}">Forget</button>
        </span>
      </div>
      <div class="vrow hint">
        from ${l.fromProject ? `<a class="pchip" href="#projects">${escapeHtml(l.fromProject)}</a>` : "—"} · ${escapeHtml(agentWhen(l.capturedAt))}
        ${l.kind === "oauth" && l.expiresAt ? ` · access token valid for ${inHours(l.expiresAt)}, refreshed by sadbox ahead of time${l.refreshedAt ? ` (last ${escapeHtml(agentWhen(l.refreshedAt))})` : ""}` : ""}
      </div>
      ${l.status ? `<div class="vrow login-bad">⚠ ${escapeHtml(l.status)}</div>` : ""}
    </div>`).join("")
    : `<div class="empty">No logins yet — log in to an agent in any VM and it shows up here within half a minute.</div>`;
  $("#agents-history").innerHTML = a.history.length ? a.history.map((h) => {
    const live = a.liveNames.includes(h.name);
    return `
    <div class="vitem-card">
      <div class="vrow">
        <span class="sec-name">${escapeHtml(h.name)}</span>
        ${live ? `<span class="dbadge fetch">mounted</span>` : `<span class="tbadge">no project</span>`}
        <span class="hint">${h.tools.map((t) => `${escapeHtml(TOOL_NAMES[t.tool] || t.tool)} ${fmtBytes(t.bytes)}`).join(" · ")}</span>
        <span class="vactions">
          <button type="button" class="mini danger" data-del-history="${escapeHtml(h.name)}" ${live ? `disabled title="Destroy the project first — its VM has this mounted"` : ""}>Delete</button>
        </span>
      </div>
      <div class="vrow hint">${fmtBytes(h.bytes)} · last changed ${escapeHtml(agentWhen(h.updatedAt))}</div>
    </div>`;
  }).join("") : `<div class="empty">None kept yet.</div>`;
}
$("#view-agents").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const status = $("#agents-status");
  try {
    if (b.dataset.forget) {
      const [tool, provider] = b.dataset.forget.split("/");
      const what = tool === "claude"
        ? "Every VM's Claude placeholders stop working; log in again in any VM to give sadbox a new login."
        : "VMs that already have this key keep it; new VMs won't get it.";
      if (!confirm(`Forget the ${TOOL_NAMES[tool] || tool} login (${provider})? ${what}`)) return;
      await api(`/api/agents/logins/${encodeURIComponent(tool)}/${encodeURIComponent(provider)}`, { method: "DELETE" });
    } else if (b.dataset.delHistory) {
      if (!confirm(`Delete the agents' conversation history kept for "${b.dataset.delHistory}"? This cannot be undone.`)) return;
      await api(`/api/agents/history/${encodeURIComponent(b.dataset.delHistory)}`, { method: "DELETE" });
    } else if (b.hasAttribute("data-refresh-login")) {
      status.textContent = "Refreshing…";
      const r = await api("/api/agents/claude/refresh", { method: "POST" });
      status.textContent = r.ok ? "Claude login refreshed." : "The refresh did not work — see the login above.";
    }
    await refreshAgents();
  } catch (err) { status.textContent = err.message; }
});
$("#agents-apply").onclick = async () => {
  const status = $("#agents-status");
  status.textContent = "Copying into running VMs…";
  try {
    const r = await api("/api/agents/apply", { method: "POST" });
    status.textContent = r.length
      ? r.map((x) => `${x.project}: ${x.error ? `failed (${x.error})` : x.wrote.length ? x.wrote.join(", ") : "already current"}`).join(" · ")
      : "No VM is running.";
  } catch (e) { status.textContent = e.message; }
};

// ---- container service status (home page) ----
// Every VM operation goes through the backend's service; when it is down,
// start / rebuild / destroy all fail, so say so up front and how to fix it.
async function refreshServiceStatus() {
  const el = $("#svc-status");
  let s;
  try {
    s = await api("/api/system/status");
  } catch (e) {
    s = { running: false, error: `could not ask sadbox: ${e.message}` };
  }
  el.hidden = false;
  el.classList.toggle("down", !s.running);
  if (s.running) {
    const vms = s.containersTotal != null ? ` · ${s.containersRunning ?? 0} of ${s.containersTotal} VMs running` : "";
    el.innerHTML = `<span class="dot running"></span><b>Container service running</b>
      <span class="svc-meta">${s.version ? `v${escapeHtml(s.version)}` : ""}${vms}</span>`;
    return;
  }
  el.innerHTML = `<h3><span class="dot down"></span>Container service is not running</h3>
    <p>${escapeHtml(s.error || "unknown error")}</p>
    ${s.fix ? `<p>Start it from a terminal on this machine: <code>${escapeHtml(s.fix)}</code></p>` : ""}
    <p class="svc-meta">Until it is back, projects cannot be started, stopped, rebuilt or destroyed.</p>`;
}

// ---- nested project list in the sidebar ----
async function refreshNavTree() {
  const [projects, pending] = await Promise.all([
    api("/api/projects").catch(() => []),
    api("/api/net/pending").catch(() => ({})),
  ]);
  const cur = location.hash.slice(1).split("/");
  const activeId = cur[0] === "project" ? cur[1] : null;
  $("#nav-projects").innerHTML = projects.map((p) => {
    const state = p.state;
    const n = pending[p.id] || 0;
    const badge = n ? `<span class="nav-badge" title="${n} request(s) awaiting approval">${n}</span>` : "";
    return `<li><a href="#project/${p.id}" class="nav-sub ${p.id === activeId ? "active" : ""}">
      <span class="dot ${state}"></span>${p.name}${badge}</a></li>`;
  }).join("");
}

// ---- vault (docs/research/12) ----
// An item is a variable (value shown) or a secret (hidden until the eye icon
// asks for it), typed string / number / json, and used by a VM either via the
// proxy (the VM holds a placeholder; the proxy swaps in the value on requests
// to the item's hosts) or fetched at runtime. Hosts are shown as chips;
// ✕ removes one, "+ host" adds one.
const SECRET_PRESETS = {
  github: { name: "GITHUB_TOKEN", hosts: ["api.github.com", "github.com", "uploads.github.com"] },
  anthropic: { name: "ANTHROPIC_API_KEY", hosts: ["api.anthropic.com"] },
  openai: { name: "OPENAI_API_KEY", hosts: ["api.openai.com"] },
};

function modeBadges(s) {
  const mode = s.mode === "proxy"
    ? `<span class="dbadge proxy" title="The VM holds a placeholder; the proxy swaps in the real value">via proxy</span>`
    : `<span class="dbadge fetch" title="Nothing in the VM; the app fetches it at runtime">fetch at runtime</span>`;
  const env = s.inEnv ? `<span class="dbadge env" title="Also written into the VM's env file — readable inside the VM">+ env file</span>` : "";
  const ask = s.mode === "fetch" && s.askOnFetch ? `<span class="dbadge ask" title="Each fetch waits for your approval">asks first</span>` : "";
  const where = s.mode === "proxy"
    ? (s.swapUrl ? `<span class="dbadge env" title="Also swapped in the URL">+ url</span>` : "")
      + (s.swapBody ? `<span class="dbadge env" title="Also swapped in request bodies">+ body</span>` : "")
    : "";
  return mode + where + env + ask;
}
const kindBadge = (s) => `<span class="kbadge ${s.kind}">${s.kind}</span><span class="tbadge">${s.type}</span>`;

function bindingChips(s) {
  if (s.mode !== "proxy" && !(s.bindings || []).length) return "";
  const now = Date.now();
  const chips = (s.bindings || []).map((b) => {
    const expired = b.expires_at && Date.parse(b.expires_at) <= now;
    const spec = `${b.method ? `${escapeHtml(b.method)} ` : ""}${escapeHtml(b.host)}${b.path ? escapeHtml(b.path) : ""}`
      + (b.header ? ` <span class="bnote">${escapeHtml(b.header)}</span>` : "")
      + (b.expires_at ? ` <span class="bnote">${expired ? "expired" : `until ${fmtClock(Date.parse(b.expires_at))}`}</span>` : "");
    return `<span class="bchip${expired ? " expired" : ""}">${spec}<button type="button" class="link-del"
      data-unbind="${s.id}" data-bid="${b.id}" title="Stop sending ${escapeHtml(s.name)} to ${escapeHtml(b.host)}">✕</button></span>`;
  }).join("");
  const none = (s.bindings || []).length ? "" : `<span class="bnote">no hosts — every use asks first</span>`;
  return `<div class="bindings">${chips}${none}
    <button type="button" class="link-add" data-bind-open="${s.id}">+ host</button>
    <form class="bind-add" data-bind="${s.id}" hidden>
      <select name="method"><option value="">any</option><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select>
      <input name="host" required placeholder="api.example.com or *.example.com/v1/*">
      <button type="submit">add</button>
    </form>
  </div>`;
}

/** "api.github.com/repos/*" → { host: "api.github.com", path: "/repos/*" } */
function parseBinding(spec) {
  const t = spec.trim().replace(/^https?:\/\//, "");
  const i = t.indexOf("/");
  return i < 0 ? { host: t } : { host: t.slice(0, i), path: t.slice(i) };
}
const parseHosts = (text) => String(text || "").split(/[\s,]+/).filter(Boolean).map(parseBinding);

/** Clicks on host chips / "+ host" forms inside `root`; `after` re-renders. */
function wireBindings(root, after) {
  root.addEventListener("click", async (e) => {
    const open = e.target.closest("[data-bind-open]");
    if (open) {
      const f = open.parentElement.querySelector("form.bind-add");
      f.hidden = !f.hidden;
      if (!f.hidden) f.elements["host"].focus();
      return;
    }
    const del = e.target.closest("[data-unbind]");
    if (!del) return;
    e.stopPropagation();
    try {
      await api(`/api/vault/${del.dataset.unbind}/bindings/${del.dataset.bid}`, { method: "DELETE" });
      await after();
    } catch (err) { alert(err.message); }
  });
  root.addEventListener("submit", async (e) => {
    const f = e.target.closest("form.bind-add");
    if (!f) return;
    e.preventDefault();
    try {
      await api(`/api/vault/${f.dataset.bind}/bindings`, {
        // (f.method is the form's own method; the select is f.elements)
        method: "POST", body: { ...parseBinding(f.elements["host"].value), method: f.elements["method"].value || undefined },
      });
      await after();
    } catch (err) { alert(err.message); }
  });
}

// a secret's value, once revealed, until hidden again (or 30 s pass)
const revealed = new Map(); // id → value
const MASK = "••••••••";

function valueCell(s) {
  if (s.kind === "variable") return `<code class="vval">${escapeHtml(s.value ?? "")}</code>`;
  const shown = revealed.has(s.id);
  return `<code class="vval${shown ? "" : " masked"}">${shown ? escapeHtml(revealed.get(s.id)) : MASK}</code>
    <button type="button" class="mini eye" data-reveal="${s.id}" title="${shown ? "Hide" : "Reveal (logged)"}">${shown ? "🙈" : "👁"}</button>`;
}

function projectChips(s) {
  if (!s.projectIds.length) return `<span class="bnote">no project can use it</span>`;
  return s.projectIds.map((id) => `<a class="pchip" href="#project/${id}">${escapeHtml(projectNames[id] || id)}</a>`).join("");
}
/** "my-app, other-app" — the label that tells two GITHUB_TOKENs apart. */
function projectLabelOf(s) {
  if (!s.projectIds.length) return "";
  return s.projectIds.map((id) => projectNames[id] || id).join(", ");
}
/** What to show beside the name: its note (what it was made for), or — for an
 *  older item without one — the project(s) using it now. */
function itemForLabel(s) {
  return s.note || (s.projectIds.length ? `for ${projectLabelOf(s)}` : "");
}

// projects that may fetch an item without being asked (an approval answered
// with a window or "always"); ✕ takes that back
function grantChips(s) {
  if (s.mode !== "fetch" || !s.askOnFetch || !(s.fetchGrants || []).length) return "";
  return `<div class="vrow"><span class="hint">fetches without asking:</span> ${s.fetchGrants.map((g) =>
    `<span class="bchip">${escapeHtml(projectNames[g.projectId] || g.projectId)}
      <span class="bnote">${g.expiresAt ? `until ${fmtClock(Date.parse(g.expiresAt))}` : "always"}</span><button type="button" class="link-del"
      data-revoke="${s.id}" data-pid="${g.projectId}" title="Ask again next time">✕</button></span>`).join("")}</div>`;
}

async function loadProjectNames() {
  const list = await api("/api/projects").catch(() => []);
  projectNames = Object.fromEntries(list.map((p) => [p.id, p.name]));
  return list;
}

async function refreshVault() {
  [vaultCache] = await Promise.all([api("/api/vault"), loadProjectNames()]);
  renderVaultList();
  // keep ticks across a refresh (e.g. after making a new item from the form)
  const ticked = new Set([...document.querySelectorAll("#create-secrets input[name=secret]:checked")].map((c) => c.value));
  $("#create-secrets").innerHTML = vaultCache.length
    ? vaultCache.map((s) => {
        const label = itemForLabel(s);
        return `<label><input type="checkbox" name="secret" value="${s.id}"${ticked.has(s.id) ? " checked" : ""}>${escapeHtml(s.name)}` +
          (label ? ` <span class="hint">${escapeHtml(label)}</span>` : "") +
          ` <span class="hint">· ${s.kind}${s.mode === "proxy" ? ", via proxy" : ""}</span></label>`;
      }).join("")
    : `<span class="empty">none in the vault yet</span>`;
}

function renderVaultList() {
  const el = $("#vault-list");
  if (!el) return;
  el.innerHTML = vaultCache.length
    ? vaultCache.map((s) => `
      <div class="vitem-card" data-item="${s.id}">
        <div class="vrow">
          <span class="sec-name">${escapeHtml(s.name)}</span>${kindBadge(s)}${modeBadges(s)}
          ${itemForLabel(s) ? `<span class="vfor" title="The project it was made for, or the project(s) that may use it now">${escapeHtml(itemForLabel(s))}</span>` : ""}
          <span class="vactions">
            <button type="button" class="mini" data-edit-item="${s.id}">Edit</button>
            <button type="button" class="mini danger" data-del-item="${s.id}" data-name="${escapeHtml(s.name)}">Delete</button>
          </span>
        </div>
        <div class="vrow vvalue">${valueCell(s)}</div>
        <div class="vrow"><span class="hint">projects:</span> ${projectChips(s)}</div>
        ${grantChips(s)}
        ${bindingChips(s)}
      </div>`).join("")
    : `<div class="empty">The vault is empty. Add a variable or a secret to get started.</div>`;
}

const vaultList = $("#vault-list");
vaultList.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.dataset.reveal) {
      const id = b.dataset.reveal;
      if (revealed.has(id)) revealed.delete(id);
      else {
        revealed.set(id, (await api(`/api/vault/${id}/value`)).value);
        setTimeout(() => { revealed.delete(id); renderVaultList(); }, 30_000);
      }
      renderVaultList();
    } else if (b.dataset.revoke) {
      await api(`/api/vault/${b.dataset.revoke}/grants/${b.dataset.pid}`, { method: "DELETE" });
      await refreshVault();
    } else if (b.dataset.editItem) {
      openItemDialog(vaultCache.find((s) => s.id === b.dataset.editItem));
    } else if (b.dataset.delItem) {
      if (!confirm(`Delete ${b.dataset.name} from the vault? Every project using it loses it.`)) return;
      await api(`/api/vault/${b.dataset.delItem}`, { method: "DELETE" });
      revealed.delete(b.dataset.delItem);
      await refreshVault();
    }
  } catch (err) { alert(err.message); }
});
wireBindings(vaultList, refreshVault);
$("#vault-new").onclick = () => openItemDialog(null);

// ---- the item dialog: create or edit ----
const vitem = $("#vitem");
const vform = $("#vitem-form");
let vitemEditing = null;      // the item being edited, or null for a new one
let vitemAfter = null;        // what else to re-render after a save (a project's dialog)

function syncItemForm() {
  const json = vform.type.value === "json";
  const secret = vform.kind.value === "secret";
  vform.value.hidden = json;
  vform.valueJson.hidden = !json;
  $("#vitem-eye").hidden = json || !secret;
  if (!json) vform.value.type = secret && !vform.value.dataset.shown ? "password" : "text";
  vform.value.inputMode = vform.type.value === "number" ? "decimal" : "text";
  const proxy = vform.mode.value === "proxy";
  vform.querySelector(".vitem-proxy").hidden = !proxy;
  vform.querySelector(".vitem-fetch").hidden = proxy;
}

async function openItemDialog(item, opts = {}) {
  vitemEditing = item;
  vitemAfter = opts.after || null;
  vform.reset();
  delete vform.value.dataset.shown;
  const editing = !!item;
  $("#vitem-title").textContent = editing ? `Edit ${item.name}` : "New vault item";
  $("#vitem-save").textContent = editing ? "Save" : "Create";
  $("#vitem-status").textContent = "";
  vform.elements["name"].value = item?.name ?? "";
  vform.elements["note"].value = item?.note ?? "";
  vform.kind.value = item?.kind ?? "secret";
  vform.type.value = item?.type ?? "string";
  vform.mode.value = item?.mode ?? "fetch";
  vform.askOnFetch.checked = item ? item.askOnFetch : true;
  vform.inEnv.checked = item?.inEnv ?? false;
  vform.swapUrl.checked = item?.swapUrl ?? false;
  vform.swapBody.checked = item?.swapBody ?? false;
  // a variable's value is known; a secret's is only replaced if a new one is typed
  const known = item?.kind === "variable" ? item.value ?? "" : "";
  vform.value.value = known; vform.valueJson.value = known;
  $("#vitem-keep").hidden = !(editing && item.kind === "secret");
  $("#vitem-hosts-now").textContent = editing && item.bindings.length
    ? `already: ${item.bindings.map((b) => b.host + (b.path || "")).join(", ")} — remove them on the vault page` : "";
  const projects = await loadProjectNames();
  const have = new Set(item?.projectIds ?? opts.projectIds ?? []);
  $("#vitem-projects").innerHTML = projects.length
    ? projects.map((p) => `<label><input type="checkbox" name="project" value="${p.id}" ${have.has(p.id) ? "checked" : ""}>${escapeHtml(p.name)}</label>`).join("")
    : `<span class="empty">no projects yet</span>`;
  syncItemForm();
  vitem.showModal();
}

vform.addEventListener("change", (e) => {
  // a new secret asks before each fetch by default, a new variable does not
  if (e.target.name === "kind" && !vitemEditing) vform.askOnFetch.checked = vform.kind.value === "secret";
  if (e.target.name === "type") {
    if (vform.type.value === "json") vform.valueJson.value = vform.value.value;
    else vform.value.value = vform.valueJson.value.trim() || vform.value.value;
  }
  syncItemForm();
});
$("#vitem-eye").onclick = () => {
  if (vform.value.dataset.shown) delete vform.value.dataset.shown; else vform.value.dataset.shown = "1";
  syncItemForm();
};
vform.addEventListener("click", (e) => {
  const b = e.target.closest("[data-preset]");
  if (!b) return;
  const p = SECRET_PRESETS[b.dataset.preset];
  vform.hosts.value = p.hosts.join(", ");
  if (!vform.elements["name"].value) vform.elements["name"].value = p.name;
});
$("#vitem-close").onclick = () => vitem.close();

vform.onsubmit = async (e) => {
  e.preventDefault();
  const status = $("#vitem-status");
  const value = vform.type.value === "json" ? vform.valueJson.value : vform.value.value;
  const fields = {
    name: vform.elements["name"].value.trim(), note: vform.elements["note"].value.trim(),
    kind: vform.kind.value, type: vform.type.value, mode: vform.mode.value,
    inEnv: vform.mode.value === "fetch" && vform.inEnv.checked, askOnFetch: vform.askOnFetch.checked,
    swapUrl: vform.swapUrl.checked, swapBody: vform.swapBody.checked,
  };
  const projectIds = [...vform.querySelectorAll("input[name=project]:checked")].map((c) => c.value);
  const hosts = fields.mode === "proxy" ? parseHosts(vform.hosts.value) : [];
  // an empty value is only "keep it" for a secret being edited
  const keep = vitemEditing?.kind === "secret" && value === "";
  if (!keep && value === "" && fields.type !== "string") { status.textContent = "a value is needed"; return; }
  if (!vitemEditing && value === "") { status.textContent = "a value is needed"; return; }
  status.textContent = "Saving…";
  try {
    if (!vitemEditing) {
      await api("/api/vault", { method: "POST", body: { ...fields, value, projectIds, bindings: hosts } });
    } else {
      const id = vitemEditing.id;
      // hosts first: switching to proxy needs one
      for (const b of hosts) await api(`/api/vault/${id}/bindings`, { method: "POST", body: b });
      await api(`/api/vault/${id}`, { method: "PATCH", body: { ...fields, ...(keep ? {} : { value }) } });
      await api(`/api/vault/${id}/projects`, { method: "PUT", body: { projectIds } });
      revealed.delete(id);
    }
    vitem.close();
    await refreshVault();
    if (vitemAfter) await vitemAfter();
  } catch (err) { status.textContent = err.message; }
};

// ---- projects ----
function skeletonCards(n) {
  const metaLines = () => Array.from({ length: 3 }, (_, i) =>
    `<span class="sk sk-line" style="width:${[85, 70, 55][i]}%;margin-bottom:6px"></span>`).join("");
  return Array.from({ length: n }, () =>
    `<div class="card skeleton">
      <h3><span class="sk sk-dot"></span><span class="sk sk-line" style="width:45%"></span></h3>
      <div class="meta">${metaLines()}</div>
      <div class="row">${Array.from({ length: 4 }, () => `<span class="sk sk-btn"></span>`).join("")}</div>
    </div>`).join("");
}

let projectsLoaded = false;
async function refreshProjects() {
  const el = $("#projects");
  if (!projectsLoaded) el.innerHTML = skeletonCards(3);
  let projects;
  try {
    projects = await api("/api/projects");
  } catch (e) {
    el.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
    return;
  }
  projectsLoaded = true;
  if (!projects.length) {
    el.innerHTML = `<div class="empty">No projects. Create one to get started.</div>`;
    return;
  }
  el.innerHTML = projects.map((p) => {
    const state = p.state;
    const gitLine = p.git_remote
      ? `<br>${p.source_path ? "remote" : "cloned from"} ${escapeHtml(p.git_remote)}${p.has_git_token ? " 🔑" : ""}`
      : "";
    return `
    <div class="card" data-id="${p.id}">
      <h3><a href="#project/${p.id}"><span class="dot ${state}"></span>${p.name}</a></h3>
      <div class="meta">
        ${state} · ${p.image}${p.live?.address ? ` · ${p.live.address}` : ""}<br>
        ${p.source_path ? escapeHtml(p.source_path) + "<br>" : ""}${p.empty ? "empty VM — repositories cloned in it" : `branch ${escapeHtml(p.branch || `sadbox/${p.name}`)}`}${gitLine}${p.error ? `<br><span style="color:var(--bad)">${escapeHtml(p.error)}</span>` : ""}
      </div>
      <div class="row">
        <button data-details="${p.id}">Details</button>
        ${powerButton(p)}
        <button data-term="${p.id}" data-name="${p.name}">${ICON.terminal}Terminal ↗</button>
        <button data-edit="${p.id}" data-name="${p.name}">${ICON.editor}Editor ↗</button>
        ${p.sync_folder ? `<button data-sync="${p.id}">${ICON.sync}Sync back</button>` : ""}
        ${p.sync_folder ? pushButton(p) : ""}
        <button data-secrets="${p.id}" data-name="${p.name}">${ICON.secrets}Vault…</button>
        <button class="danger" data-destroy="${p.id}" data-name="${p.name}">${ICON.destroy}Destroy</button>
      </div>
      <div class="sync-result"></div>
    </div>`;
  }).join("");
}

// What a Sync back did, in words
function syncSummary(r) {
  const review = r.kind === "git" ? `\n\nNothing was committed — review with 'git status' / 'git diff' in that folder and commit what you want.` : "";
  if (r.applied === "copied") {
    return `Synced into ${r.folder}${r.forced ? " (overwriting your changes there)" : ""} — its files now match the VM's workdir.${review}` +
      (r.changed ? `\n\n${r.changed}` : "");
  }
  if (r.applied === "current") {
    return `Already up to date — nothing has changed in the VM since the last sync.` + (r.note ? `\n\nNote: ${r.note}.` : "");
  }
  return `Nothing in ${r.folder} was changed: ${r.note}` +
    (r.blocking.length ? `:\n\n${r.blocking.map((f) => "  " + f).join("\n")}\n\nCommit, stash or move them and press Sync back again — or overwrite them with the VM's versions.` : "");
}
// ---- push: the folder on this machine → the VM's workdir ----
function pushButton(p) {
  return p.state === "running"
    ? `<button data-push="${p.id}" title="Copy the folder's changed files into the VM (never .env files)">${ICON.push}Push to VM</button>`
    : `<button disabled title="Start the VM to push into it">${ICON.push}Push to VM</button>`;
}
function pushSummary(r) {
  const env = r.excluded.length ? `\n\nNot pushed (env files never are): ${r.excluded.join(", ")}` : "";
  const odd = r.skipped.length ? `\n\nCould not push (line break in the name): ${r.skipped.length} file(s)` : "";
  if (r.applied === "copied") {
    return `Pushed ${r.changed.length} file${r.changed.length === 1 ? "" : "s"} from ${r.folder} into the VM${r.forced ? " (overwriting uncommitted changes there)" : ""}. ` +
      `They show up there as uncommitted changes.\n\n${r.changed.map((f) => "  " + f).join("\n")}${env}${odd}`;
  }
  if (r.applied === "current") return `Nothing to push — the VM already has the folder's files.${env}${odd}`;
  return `Nothing was pushed: these files have uncommitted changes in the VM, which the push would overwrite:\n\n` +
    `${r.blocking.map((f) => "  " + f).join("\n")}\n\nCommit or stash them in the VM and push again — or overwrite them with the folder's versions.${env}${odd}`;
}
async function runPush(id, container, force) {
  const r = await api(`/api/projects/${id}/push`, { method: "POST", body: { force } });
  const again = r.applied === "not-applied"
    ? `<button class="danger mini" data-push="${id}" data-force="1">Overwrite ${r.blocking.length} file${r.blocking.length === 1 ? "" : "s"} in the VM</button>`
    : "";
  container.querySelector(".sync-result").innerHTML = `<pre class="result">${escapeHtml(pushSummary(r))}</pre>${again}`;
}

/** Run a sync and show what it did under the project (with a way to force it
 *  when files in the folder were in the way). */
async function runSync(id, container, force) {
  const r = await api(`/api/projects/${id}/sync`, { method: "POST", body: { force } });
  const again = r.applied === "not-applied" && r.blocking.length
    ? `<button class="danger mini" data-sync="${id}" data-force="1">Overwrite ${r.blocking.length} file${r.blocking.length === 1 ? "" : "s"}</button>`
    : r.applied === "current" && r.note
      ? `<button class="mini" data-sync="${id}" data-force="1" title="Write the VM's files over the folder's again">Make the folder match the VM again</button>`
      : "";
  container.querySelector(".sync-result").innerHTML =
    `<pre class="result">${escapeHtml(syncSummary(r))}</pre>${again}`;
}

// Icons for the action buttons — drawn in the button's own colour
const svg = (body) => `<svg class="ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  terminal: svg(`<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>`),
  editor: svg(`<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>`),
  push: svg(`<path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/><line x1="5" y1="21" x2="19" y2="21"/>`),
  sync: svg(`<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>`),
  secrets: svg(`<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>`),
  rebuild: svg(`<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>`),
  stop: svg(`<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>`),
  start: svg(`<polygon points="7 5 19 12 7 19" fill="currentColor"/>`),
  destroy: svg(`<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>`),
};

// Stop / Start for a project's VM, by its state
const powerBusy = new Map(); // project id -> label, while a request is out
function powerButton(p) {
  const busy = powerBusy.get(p.id) || (p.state === "starting" ? "Starting…" : p.state === "stopping" ? "Stopping…" : null);
  if (busy) return `<button disabled><span class="spinner"></span> ${busy}</button>`;
  if (p.state === "running") return `<button class="stop" data-stop="${p.id}" data-name="${p.name}" title="Shut the VM down; its files are kept">${ICON.stop}Stop</button>`;
  if (p.state === "stopped") return `<button class="primary" data-start="${p.id}" title="Boot the VM again; its files are as you left them">${ICON.start}Start</button>`;
  return "";
}
async function power(id, action) {
  powerBusy.set(id, action === "start" ? "Starting…" : "Stopping…");
  const repaint = () => {
    if (location.hash === `#project/${id}`) { if (lastDetail?.id === id) paintDetail(lastDetail); return renderDetail(id); }
    refreshNavTree(); return refreshProjects();
  };
  if (lastDetail?.id === id && location.hash === `#project/${id}`) paintDetail(lastDetail); else refreshProjects();
  try {
    const r = await api(`/api/projects/${id}/${action}`, { method: "POST", body: {} });
    if (lastDetail?.id === id) lastDetail.state = r.state;
  } finally {
    powerBusy.delete(id);
    await repaint();
  }
}

// Change how much memory a project's VM has. A running VM restarts to take it.
async function changeMemory(id, name, currentMB, running) {
  const nowGB = currentMB ? +(currentMB / 1024).toFixed(2) : null;
  const answer = prompt(
    `Memory for "${name}", in GB${nowGB ? ` (now ${nowGB})` : ""}.\n\n` +
    (running
      ? "The VM restarts to apply it: agents and terminals running in it end. Its files, installed packages and logins are kept."
      : "It applies the next time the VM starts."),
    String(nowGB && nowGB >= 4 ? nowGB : 4));
  if (answer == null) return;
  const gb = Number(answer.trim().replace(/\s*gb?$/i, ""));
  if (!Number.isFinite(gb) || gb <= 0) throw new Error("Enter a number of GB, for example 4");
  const memoryMB = Math.round(gb * 1024);
  if (memoryMB === currentMB) return;
  if (running) {
    powerBusy.set(id, "Restarting…");
    if (lastDetail?.id === id) paintDetail(lastDetail);
  }
  try {
    const r = await api(`/api/projects/${id}/memory`, { method: "PUT", body: { memoryMB } });
    if (r.applied === false) alert("The setting is saved, but the VM still reports its old memory size. A Rebuild will apply it.");
  } finally {
    powerBusy.delete(id);
    if (location.hash === `#project/${id}`) await renderDetail(id);
  }
}

/** Install or remove an optional app, keeping the panel's spinner up for the
 *  (sometimes minutes-long) apt run. */
async function changeApp(id, appId, install, label) {
  appBusy.set(id, appId);
  if (lastDetail?.id === id) paintDetail(lastDetail);
  try {
    await api(`/api/projects/${id}/apps${install ? "" : `/${encodeURIComponent(appId)}`}`, {
      method: install ? "POST" : "DELETE",
      body: install ? { id: appId } : undefined,
    });
  } catch (err) {
    alert(`${label}: ${err.message}`);
  } finally {
    appBusy.delete(id);
    if (location.hash === `#project/${id}`) await renderDetail(id);
  }
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.dataset.term) {
      window.open(`/terminal?id=${b.dataset.term}&name=${b.dataset.name}`, "_blank");
    } else if (b.dataset.edit) {
      window.open(`/editor?id=${b.dataset.edit}&name=${b.dataset.name}`, "_blank");
    } else if (b.dataset.details) {
      location.hash = `project/${b.dataset.details}`;
    } else if (b.dataset.start) {
      await power(b.dataset.start, "start");
    } else if (b.dataset.stop) {
      if (confirm(`Stop "${b.dataset.name}"? Its files are kept, but whatever is running in it — agents, terminals, dev servers — ends.`)) {
        await power(b.dataset.stop, "stop");
      }
    } else if (b.dataset.sync) {
      const force = b.dataset.force === "1";
      if (force && !confirm("Overwrite the folder's versions of these files with the VM's? Your changes to them in the folder are lost.")) return;
      const label = b.innerHTML;
      const container = b.closest(".card") || $("#view-detail");
      b.disabled = true; b.innerHTML = `<span class="spinner"></span> Syncing…`;
      try { await runSync(b.dataset.sync, container, force); }
      finally { b.disabled = false; b.innerHTML = label; }
    } else if (b.dataset.push) {
      const force = b.dataset.force === "1";
      if (force && !confirm("Overwrite the VM's versions of these files with the folder's? The uncommitted changes to them in the VM are lost.")) return;
      const label = b.innerHTML;
      const container = b.closest(".card") || $("#view-detail");
      b.disabled = true; b.innerHTML = `<span class="spinner"></span> Pushing…`;
      try { await runPush(b.dataset.push, container, force); }
      finally { b.disabled = false; b.innerHTML = label; }
    } else if (b.dataset.linkFolder) {
      // connect a local folder to a project cloned from a git URL (reuses the folder picker)
      const id = b.dataset.linkFolder;
      pickerOnSelect = (path) => { setSyncFolder(id, path); };
      picker.showModal();
      loadDir(b.dataset.current || null).catch(() => loadDir(null));
    } else if (b.dataset.gitRemote) {
      openGitRemote(b.dataset);
    } else if (b.dataset.unlinkFolder) {
      if (confirm("Disconnect this folder? Nothing in it is changed; the project just stops syncing there.")) {
        setSyncFolder(b.dataset.unlinkFolder, null);
      }
    } else if (b.dataset.secrets) {
      openProjectSecrets(b.dataset.secrets, b.dataset.name || b.closest(".card")?.querySelector("h3").textContent.trim() || "project");
    } else if (b.dataset.memory) {
      await changeMemory(b.dataset.memory, b.dataset.name, Number(b.dataset.mb) || null, b.dataset.running === "1");
    } else if (b.dataset.installApp) {
      await changeApp(b.dataset.installApp, b.dataset.app, true, b.dataset.label || b.dataset.app);
    } else if (b.dataset.removeApp) {
      if (confirm(`Remove ${b.dataset.label} from this VM? Its disk keeps any dependencies apt left for other packages; you can install it again here.`)) {
        await changeApp(b.dataset.removeApp, b.dataset.app, false, b.dataset.label || b.dataset.app);
      }
    } else if (b.dataset.rebuild) {
      const what = b.dataset.empty === "1"
        ? `The VM is destroyed and an empty one takes its place: the repositories cloned in it go too — push what you want to keep first.`
        : `The VM is destroyed and recreated from the project's original source (local folder re-copied, or git remote re-cloned). Unsynced work inside the VM will be lost.`;
      if (confirm(`Rebuild "${b.dataset.name}"? ${what} The agents' conversation history is kept.`)) {
        b.disabled = true; b.textContent = "Rebuilding…";
        try {
          await api(`/api/projects/${b.dataset.rebuild}/rebuild`, { method: "POST", body: {} });
          if (location.hash.startsWith("#project/")) renderDetail(b.dataset.rebuild);
          else { refreshProjects(); refreshNavTree(); }
        } finally { b.disabled = false; b.textContent = "Rebuild"; }
      }
    } else if (b.dataset.destroy) {
      if (confirm(`Destroy project "${b.dataset.name}"? The VM and any unsynced work in it are deleted. The agents' conversation history is kept, and comes back if you create a project with the same name.`)) {
        await api(`/api/projects/${b.dataset.destroy}`, { method: "DELETE" });
        if (location.hash.startsWith("#project/")) location.hash = "projects";
        else { refreshProjects(); refreshNavTree(); }
      }
    }
  } catch (err) {
    alert(err.message);
    refreshProjects();
  }
});

// ---- a project's vault dialog: which items it may use ----
const psec = $("#psec");
let psecProjectId = null;

// what this VM holds for a proxy item — safe to show and copy (it's not the value)
function placeholderLine(s) {
  if (s.mode !== "proxy") return "";
  if (!s.placeholder) return `<div class="phline hint">placeholder made when the VM next gets its vault items</div>`;
  return `<div class="phline"><span class="hint">in this VM:</span> <code>${escapeHtml(s.placeholder)}</code>
    <button type="button" class="link-add" data-copy="${escapeHtml(s.placeholder)}">copy</button></div>`;
}

async function renderProjectVault() {
  const [view] = await Promise.all([api(`/api/projects/${psecProjectId}/vault`), refreshVault()]);
  const mine = new Map(view.map((s) => [s.id, s]));
  $("#psec-items").innerHTML = vaultCache.length
    ? vaultCache.map((s) => {
        const m = mine.get(s.id);
        return `<div class="psec-g"><label><input type="checkbox" name="psec-g" value="${s.id}" ${m ? "checked" : ""}>
          <span class="sec-name">${escapeHtml(s.name)}</span></label> ${kindBadge(s)}${modeBadges(s)}${m ? placeholderLine(m) : ""}</div>`;
      }).join("")
    : `<span class="empty">the vault is empty</span>`;
  $("#psec-status").textContent = "";
}

async function openProjectSecrets(id, name) {
  psecProjectId = id;
  $("#psec-title").textContent = `Vault — ${name}`;
  psec.showModal();
  await renderProjectVault();
}

$("#psec-close").onclick = () => psec.close();
$("#psec-new").onclick = () => openItemDialog(null, { projectIds: [psecProjectId], after: renderProjectVault });
psec.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "copied"; }
  catch { b.textContent = "copy failed"; }
  setTimeout(() => { b.textContent = "copy"; }, 1500);
});
$("#psec-apply").onclick = async () => {
  const ids = [...psec.querySelectorAll("input[name=psec-g]:checked")].map((c) => c.value);
  try {
    await api(`/api/projects/${psecProjectId}/vault`, { method: "PUT", body: { itemIds: ids } });
    await renderProjectVault(); // newly given proxy items now have their placeholders
    $("#psec-status").textContent = "saved — the VM has its items";
  } catch (err) { $("#psec-status").textContent = err.message; }
};

// ---- git remote of an existing project (origin in the VM's workdir) ----
const gitremote = $("#gitremote");
let gitremoteFor = null;
function openGitRemote({ gitRemote: id, name, current, token, cloned }) {
  gitremoteFor = id;
  const f = $("#gitremote-form");
  f.reset();
  f.remote.value = current;
  f.token.placeholder = token === "1" ? "leave blank to keep the current token" : "leave blank for none";
  $("#gitremote-title").textContent = `Git remote — ${name}`;
  $("#gitremote-hint").textContent = "Set as origin in the VM's workdir, so the agent can fetch and push."
    + " A token is kept in the vault; the VM only gets a placeholder."
    + (cloned === "1" && current ? " Rebuild re-clones from this URL." : "");
  $("#gitremote-status").textContent = "";
  gitremote.showModal();
}
$("#gitremote-close").onclick = () => gitremote.close();
$("#gitremote-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  $("#gitremote-status").textContent = "Saving…";
  try {
    await api(`/api/projects/${gitremoteFor}/git-remote`, {
      method: "PUT", body: { remote: f.remote.value.trim(), token: f.token.value || undefined },
    });
    gitremote.close();
    if (location.hash === `#project/${gitremoteFor}`) renderDetail(gitremoteFor);
  } catch (err) {
    $("#gitremote-status").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---- folder picker ----
const picker = $("#picker");
let pickerPath = null;
let pickerOnSelect = null; // what to do with the chosen folder (default: fill the create form)

async function loadDir(path) {
  const q = path ? `?path=${encodeURIComponent(path)}` : "";
  const d = await api(`/api/fs/dirs${q}`);
  pickerPath = d.path;
  $("#picker-current").textContent = d.path;
  // a folder being connected for sync may be any folder; a project's source must be a repo
  const anyFolder = pickerOnSelect != null;
  $("#picker-hint").textContent = d.isGitRepo ? "✓ git repository"
    : anyFolder ? "plain folder — files will be copied in" : "not a git repo (projects need one)";
  $("#picker-hint").style.color = d.isGitRepo || anyFolder ? "var(--ok)" : "var(--warn)";
  const items = [];
  if (d.parent) items.push(`<li data-dir="${d.parent}" class="up">↩ ..</li>`);
  items.push(...d.dirs.map((e) =>
    `<li data-dir="${d.path === "/" ? "" : d.path}/${e.name}">
       📁 ${e.name}${e.isGitRepo ? ` <span class="git-badge">git</span>` : ""}</li>`));
  $("#picker-list").innerHTML = items.join("") || `<li class="empty">no subfolders</li>`;
}

$("#btn-browse").onclick = () => {
  pickerOnSelect = null;
  picker.showModal();
  loadDir($("#create-form").sourcePath.value.trim() || null).catch(() => loadDir(null));
};
$("#picker-close").onclick = () => picker.close();
$("#picker-home").onclick = () => loadDir(null);
$("#picker-list").onclick = (e) => {
  const li = e.target.closest("li[data-dir]");
  if (li) loadDir(li.dataset.dir).catch((err) => alert(err.message));
};
$("#picker-select").onclick = () => {
  const done = pickerOnSelect; pickerOnSelect = null;
  if (pickerPath) { if (done) done(pickerPath); else $("#create-form").sourcePath.value = pickerPath; }
  picker.close();
};

// ---- create project ---- (form replaces the grid while open)
// name + version chips for a baked-in toolchain (create form + detail view)
function toolchainHtml(tools) {
  if (!tools || !tools.length) return `<span class="hint">—</span>`;
  return tools.map((t) => t.version
    ? `<span class="tool"><b>${escapeHtml(t.label)}</b> <span class="tv">${escapeHtml(t.version)}</span></span>`
    : `<span class="tool absent" title="not installed in this VM">${escapeHtml(t.label)} <span class="tv">absent</span></span>`
  ).join("");
}

let toolchainCache = null;
async function loadCreateToolchain() {
  const el = $("#create-toolchain");
  if (!el) return;
  if (toolchainCache) { el.innerHTML = toolchainHtml(toolchainCache.tools); return; }
  try {
    toolchainCache = await api("/api/toolchain");
    el.innerHTML = toolchainHtml(toolchainCache.tools);
  } catch (e) {
    el.innerHTML = `<span class="hint">couldn't detect (${escapeHtml(e.message)})</span>`;
  }
}

// Optional apps a new VM can be given now (the same list is on the project
// page afterwards). The catalog lives in the supervisor (core/apps.ts).
let appCatalogCache = null;
async function loadCreateApps() {
  const el = $("#create-apps");
  if (!el) return;
  try {
    appCatalogCache ??= (await api("/api/apps")).apps;
    el.innerHTML = appCatalogCache.length ? appCatalogCache.map((a) => `
      <label>
        <input type="checkbox" name="optionalApp" value="${escapeHtml(a.id)}">
        <span class="app-text"><b>${escapeHtml(a.label)}</b>${appSize(a)}
          <div class="hint">${escapeHtml(a.summary || "")}${a.note ? ` ${escapeHtml(a.note)}` : ""}</div></span>
      </label>`).join("") : `<span class="hint">none available</span>`;
  } catch (e) {
    el.innerHTML = `<span class="hint">couldn't load (${escapeHtml(e.message)})</span>`;
  }
}
const appSize = (a) => a.approxMB ? ` <span class="hint">· about ${a.approxMB >= 1024 ? (a.approxMB / 1024).toFixed(1) + " GB" : a.approxMB + " MB"}</span>` : "";

// show the folder fields or the git-clone fields based on the source-mode toggle;
// only the visible source input is `required` (a required hidden field blocks submit)
function syncSrcMode() {
  const form = $("#create-form");
  if (!form) return;
  const mode = (form.querySelector("input[name=srcMode]:checked") || {}).value || "local";
  form.querySelectorAll(".src-group").forEach((g) => { g.hidden = g.dataset.src !== mode; });
  form.sourcePath.required = mode === "local";
  form.cloneRemote.required = mode === "git";
}

// agent history kept per project name: a new project of that name gets it back
let historyCache = [];
function showCreateHistory() {
  const el = $("#create-history");
  const name = $("#create-form").name.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  const h = historyCache.find((x) => x.name === name);
  el.hidden = !h;
  if (h) el.textContent = `Agent history from an earlier “${name}” will be mounted — ${h.tools.map((t) => t.tool).join(", ")} · ${fmtBytes(h.bytes)}.`;
}
$("#create-form").name.addEventListener("input", showCreateHistory);

// ---- create progress: the form turns into a live view of the supervisor's
// event log while the project is being made (POST /api/projects is long) ----
let createBusy = false;
let createWatch = null;
const CREATE_PHASES = {
  image: "Preparing the VM image",
  history: "Bringing in agent history",
  "create.start": "Creating the project",
  "vm.ready": "VM booted",
  "proxy.configure": "Connecting the egress proxy",
  "vault.inject": "Preparing vault access",
  "workdir.ready": "Files are in place",
  "agent.update": "Updating the agents",
  "app.install": "Installing packages",
  "app.installed": "App installed",
  "app.install.error": "App install failed",
  "terminal.ready": "Starting the terminal",
  "create.done": "Done",
};
const normProjectName = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
const elapsedText = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const eventTime = (at) => {
  const d = new Date(String(at).includes("T") ? at : String(at).replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 8);
};

function resetCreateProgress() {
  createBusy = false;
  createWatch?.stop();
  createWatch = null;
  const form = $("#create-form");
  form.classList.remove("busy");
  form.removeAttribute("aria-busy");
  $("#create-progress").hidden = true;
  $("#cp-log").innerHTML = "";
  $("#cp-phase").textContent = "Starting…";
  $("#cp-elapsed").textContent = "0:00";
  $("#cp-error").hidden = true;
  $("#cp-error").textContent = "";
  $("#cp-actions").hidden = true;
  const btn = $("#btn-create");
  btn.disabled = false;
  btn.textContent = "Create";
}

function startCreateProgress(name, mode, startedAt) {
  createBusy = true;
  const form = $("#create-form");
  form.classList.add("busy");
  form.setAttribute("aria-busy", "true");
  $("#create-progress").hidden = false;
  $("#cp-title").textContent = `Creating ${name}`;
  $("#cp-phase").textContent = mode === "git"
    ? "Preparing the image and cloning the repository…"
    : "Preparing the image and booting the VM…";
  $("#cp-elapsed").textContent = "0:00";
  $("#cp-log").innerHTML = "";
  $("#cp-error").hidden = true;
  $("#cp-error").textContent = "";
  $("#cp-actions").hidden = true;
  const btn = $("#btn-create");
  btn.disabled = true;
  btn.textContent = "Creating…";

  let stopped = false, timer = null, lastId = 0, id = null;
  const tick = setInterval(() => { $("#cp-elapsed").textContent = elapsedText(Date.now() - startedAt); }, 500);
  const phase = (text) => { $("#cp-phase").textContent = text; };
  const addEvent = (ev) => {
    const li = document.createElement("li");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = eventTime(ev.at);
    const d = document.createElement("span");
    d.className = "ev";
    const label = CREATE_PHASES[ev.type] || ev.type;
    d.innerHTML = `<strong>${escapeHtml(label)}</strong>` + (ev.detail ? ` <span class="hint">${escapeHtml(ev.detail)}</span>` : "");
    li.append(t, d);
    $("#cp-log").append(li);
    $("#cp-log").scrollTop = $("#cp-log").scrollHeight;
    phase(label);
  };
  const poll = async () => {
    if (stopped) return;
    try {
      if (!id) {
        // the row appears as soon as the supervisor starts provisioning
        const list = await api("/api/projects");
        const found = list.find((x) => normProjectName(x.name) === name && x.state === "creating")
          || list.find((x) => normProjectName(x.name) === name);
        if (found) { id = found.id; phase("Booting the VM…"); }
      } else {
        const events = await api(`/api/projects/${encodeURIComponent(id)}/events?after=${lastId}`);
        for (const ev of events) { lastId = ev.id; addEvent(ev); }
      }
    } catch {}
    if (!stopped) timer = setTimeout(poll, id ? 700 : 600);
  };
  poll();
  createWatch = {
    stop() { stopped = true; clearInterval(tick); clearTimeout(timer); },
    phase,
  };
}

function openCreateForm() {
  if (createBusy) return; // one create at a time
  resetCreateProgress();
  $("#create-form").hidden = false;
  $("#projects").hidden = true;
  $("#btn-new").hidden = true;
  loadCreateToolchain();
  loadCreateApps();
  syncSrcMode();
  // fresh items and labels, including ones made on the Vaults page or here
  refreshVault().catch(() => {});
  api("/api/history").then((h) => { historyCache = h; showCreateHistory(); }).catch(() => {});
}
function closeCreateForm() {
  if (createBusy) return;
  $("#create-form").hidden = true;
  $("#projects").hidden = false;
  $("#btn-new").hidden = false;
}
$("#btn-new").onclick = openCreateForm;
$("#home-new").onclick = () => { openCreateNext = true; location.hash = "projects"; };
$("#btn-cancel").onclick = closeCreateForm;
$("#cp-back").onclick = resetCreateProgress;
// make a vault item without leaving the create form; it shows up (and can be
// ticked) as soon as the dialog saves, whether or not any project is chosen
$("#create-vault-new").onclick = () => openItemDialog(null, { after: refreshVault });
$("#git-toggle").onchange = (e) => { $("#git-fields").hidden = !e.target.checked; };
$("#src-mode").addEventListener("change", syncSrcMode);

// ---- settings ----
async function loadSettings() {
  const s = await api("/api/settings");
  const f = $("#settings-form");
  f.defaultCpus.value = s.defaultCpus;
  f.defaultMemoryMB.value = s.defaultMemoryMB;
  f.defaultDiskGB.value = s.defaultDiskGB;
  $("#settings-status").textContent = "";
  loadGlobalRules();
}

// ---- global network allow / deny list (Settings page) ----
async function loadGlobalRules() {
  const el = $("#settings-rules");
  if (!el) return;
  let rules = [];
  try { rules = await api("/api/net/rules"); } catch (e) {
    el.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return;
  }
  el.innerHTML = rules.length
    ? rules.map((r) => {
        const parts = [r.host];
        if (r.path) parts.push("path:" + r.path);
        if (r.method) parts.push(r.method);
        const exp = r.expires_at ? ` <span class="hint">until ${fmtClock(Date.parse(r.expires_at))}</span>` : "";
        return `<div class="rule">
          <span class="ract ${r.action}">${r.action}</span>
          <span class="rspec">${escapeHtml(parts.join(" · "))}${exp}</span>
          <button class="link-del" data-del-grule="${r.id}" title="delete">✕</button>
        </div>`;
      }).join("")
    : `<div class="empty">no global rules — every VM prompts for approval on first use of a host</div>`;
}

$("#settings-rules").onclick = async (e) => {
  const b = e.target.closest("[data-del-grule]");
  if (!b) return;
  try { await api(`/api/net/rules/${b.dataset.delGrule}`, { method: "DELETE" }); } catch (err) { alert(err.message); }
  loadGlobalRules();
};
$("#settings-rule-add").onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const st = $("#settings-rule-status");
  try {
    await api("/api/net/rules", {
      method: "POST",
      body: { action: f.get("action"), host: f.get("host"), path: f.get("path") || undefined, method: f.get("method") || undefined },
    });
    e.target.reset();
    st.textContent = "added";
    st.style.color = "var(--ok)";
    loadGlobalRules();
  } catch (err) { st.textContent = err.message; st.style.color = "var(--bad)"; }
};
$("#settings-form").onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const s = await api("/api/settings", {
      method: "PUT",
      body: {
        defaultCpus: Number(f.get("defaultCpus")),
        defaultMemoryMB: Number(f.get("defaultMemoryMB")),
        defaultDiskGB: Number(f.get("defaultDiskGB")),
      },
    });
    const form = $("#settings-form");
    form.defaultCpus.value = s.defaultCpus;
    form.defaultMemoryMB.value = s.defaultMemoryMB;
    form.defaultDiskGB.value = s.defaultDiskGB;
    $("#settings-status").textContent = "saved — applies to new projects";
    $("#settings-status").style.color = "var(--ok)";
  } catch (err) {
    $("#settings-status").textContent = err.message;
    $("#settings-status").style.color = "var(--bad)";
  }
};

$("#create-form").onsubmit = async (e) => {
  e.preventDefault();
  if (createBusy) return;
  const form = e.target;
  const f = new FormData(form);
  const mode = f.get("srcMode") || "local";
  let sourcePath, git;
  let empty = false;
  if (mode === "empty") {
    // nothing to seed: repositories are cloned from the terminal
    empty = true;
  } else if (mode === "git") {
    // clone-in-VM mode: the git remote IS the source; no local folder
    git = { remote: (f.get("cloneRemote") || "").trim(), token: (f.get("cloneToken") || "").trim() || undefined };
  } else {
    sourcePath = (f.get("sourcePath") || "").trim();
    git = f.get("gitEnabled") && f.get("gitRemote")
      ? { remote: f.get("gitRemote").trim(), token: (f.get("gitToken") || "").trim() || undefined }
      : undefined;
  }

  // The form turns into progress immediately; the POST below can take minutes.
  startCreateProgress(normProjectName(f.get("name")), mode, Date.now());
  try {
    const created = await api("/api/projects", {
      method: "POST",
      body: {
        name: f.get("name"),
        sourcePath, // undefined ⇒ backend clones the git remote instead
        empty,
        apps: (f.get("apps") || "").split(",").map((s) => s.trim()).filter(Boolean),
        optionalApps: [...form.querySelectorAll("input[name=optionalApp]:checked")].map((c) => c.value),
        secretIds: [...form.querySelectorAll("input[name=secret]:checked")].map((c) => c.value),
        git,
      },
    });
    createWatch?.stop();
    createBusy = false;
    resetCreateProgress();
    form.reset();
    $("#git-fields").hidden = true;
    syncSrcMode();
    showCreateHistory();
    refreshProjects().catch(() => {});
    closeCreateForm();
    // select it: route() opens the detail view and marks it in the nav
    location.hash = `project/${created.id}`;
  } catch (err) {
    // keep the form's values; Back returns to them
    createWatch?.stop();
    $("#cp-phase").textContent = "Could not create the project";
    $("#cp-error").textContent = err.message;
    $("#cp-error").hidden = false;
    $("#cp-actions").hidden = false;
  }
};


function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- project detail view ----
const fmtBytes = (n) => {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};
const fmtDur = (s) => {
  if (s == null) return "—";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};
const bar = (used, total) => {
  if (!total) return "";
  const pct = Math.min(100, Math.round((used / total) * 100));
  return `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div><span class="bar-label">${pct}%</span>`;
};

function skeletonPanel(rows) {
  const lines = Array.from({ length: rows }, () =>
    `<dt><span class="sk sk-line" style="width:${50 + Math.floor(Math.random() * 30)}%"></span></dt>
     <dd><span class="sk sk-line" style="width:${40 + Math.floor(Math.random() * 40)}%"></span></dd>`).join("");
  return `<div class="panel stat skeleton">
    <h3><span class="sk sk-line" style="width:40%"></span></h3>
    <dl>${lines}</dl>
  </div>`;
}
function skeletonNet() {
  const lines = (n, w) => Array.from({ length: n }, () =>
    `<span class="sk sk-line" style="width:${w()}%;margin-bottom:8px"></span>`).join("");
  return `<div class="panel net-panel skeleton">
    <div class="net-head"><h3><span class="sk sk-line" style="width:90px"></span></h3></div>
    <div class="net-section">
      <div class="net-subhead"><span class="sk sk-line" style="width:120px"></span></div>
      ${lines(3, () => 55 + Math.floor(Math.random() * 35))}
    </div>
    <div class="net-section">
      <div class="net-subhead"><span class="sk sk-line" style="width:100px"></span></div>
      ${lines(5, () => 100)}
    </div>
  </div>`;
}
function showDetailSkeleton() {
  $("#detail-name").innerHTML = `<span class="sk sk-line" style="width:90px;display:inline-block"></span>`;
  $("#detail-actions").innerHTML = Array.from({ length: 4 }, () =>
    `<span class="sk sk-btn"></span>`).join("");
  // #detail-stats is refreshed on a timer; #detail-net is a persistent panel fed
  // live by SSE — keep them separate so the poll never wipes the network view.
  $("#detail-body").innerHTML =
    `<div id="detail-stats">
       <div class="loading-bar"><span class="spinner"></span> Loading VM details…</div>
       <div class="detail-grid">${skeletonPanel(6) + skeletonPanel(6) + skeletonPanel(5) + skeletonPanel(4)}</div>
     </div>
     <div id="detail-ports"></div>
     <div id="detail-links"></div>
     <div id="detail-net">${skeletonNet()}</div>
     <div class="sync-result"></div>`;
}

async function openDetail(id) {
  showDetailSkeleton();
  openPorts(id);
  openLinks(id);
  openNet(id);
  await renderDetail(id);
  clearInterval(detailTimer);
  detailTimer = setInterval(() => {
    if (location.hash === `#project/${id}`) renderDetail(id); else clearInterval(detailTimer);
  }, 4000);
}

// Loading a project's details takes a few seconds (live VM stats), so a change
// to its connected folder is shown at once instead of waiting for that:
//   folderPending — a connect/disconnect is in flight (the row shows a spinner)
//   folderKnown   — its outcome, applied over any details that were requested
//                   before it happened and would otherwise flip the row back
let lastDetail = null;
let folderPending = null; // { id, label }
let folderKnown = null;   // { id, path: string | null, at: ms }

async function renderDetail(id) {
  let d;
  const stats = $("#detail-stats") || $("#detail-body");
  const asked = Date.now();
  try { d = await api(`/api/projects/${id}/details`); }
  catch (e) { stats.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }
  if (folderKnown && folderKnown.id === id && asked < folderKnown.at) {
    d.sync_path = folderKnown.path;
    d.sync_folder = d.source_path || folderKnown.path || "";
  }
  lastDetail = d;
  paintDetail(d);
  if (netId === id) setNetIsolation(d.live ? !!d.live.isolated : null);
  // usage and tool versions were still being read — fetch again shortly rather
  // than leaving the gaps until the regular refresh
  if (d.partial) {
    clearTimeout(partialTimer);
    partialTimer = setTimeout(() => { if (location.hash === `#project/${id}`) renderDetail(id); }, 1000);
  }
}
let partialTimer = null;

/** Change the connected folder of a cloned project (path null = disconnect),
 *  with the row showing progress straight away. */
async function setSyncFolder(id, path) {
  folderPending = { id, label: path ? "Connecting…" : "Disconnecting…" };
  if (lastDetail?.id === id) paintDetail(lastDetail);
  try {
    const r = path
      ? await api(`/api/projects/${id}/sync-folder`, { method: "PUT", body: { path } })
      : await api(`/api/projects/${id}/sync-folder`, { method: "DELETE" });
    folderKnown = { id, path: r.sync_path, at: Date.now() };
    folderPending = null;
    if (lastDetail?.id === id) {
      lastDetail.sync_path = r.sync_path;
      lastDetail.sync_folder = lastDetail.source_path || r.sync_path || "";
      paintDetail(lastDetail);
    }
    if (r.hasBase === false) {
      alert(`Connected ${r.sync_path}.\n\nThis repository does not contain the commit the VM started from, so it looks like a different project. A sync will fetch the VM's branch there (${"refs/remotes/sadbox/…"}) but will not merge it into your files. If it is a clone of the same repository, run 'git pull' there first.`);
    }
  } catch (err) {
    folderPending = null;
    if (lastDetail?.id === id) paintDetail(lastDetail);
    alert(err.message);
  }
}

// Optional-app install/remove for a project, by app id (kept across the 4 s
// detail repaints so a long apt install keeps its spinner and disabled button).
const appBusy = new Map(); // project id -> app id

function optionalAppsHtml(d) {
  const apps = d.optional_apps || [];
  if (!apps.length) return "";
  const running = d.state === "running";
  return `<div class="panel" style="margin-top:16px">
    <h3>Optional apps</h3>
    <p class="hint">Installed inside this VM, on top of the base image. Chosen here or when the
      project was created; a Rebuild installs them again.</p>
    <div class="app-list">${apps.map((a) => {
      const busy = appBusy.get(d.id) === a.id;
      const anyBusy = appBusy.has(d.id);
      const label = escapeHtml(a.label);
      return `<div class="app-row">
        <div class="app-what"><b>${label}</b> <span class="hint">${escapeHtml(a.summary || "")}</span>
          ${a.note ? `<div class="hint">${escapeHtml(a.note)}</div>` : ""}</div>
        <div class="app-state">${busy
          ? `<span class="spinner"></span> <span class="hint">${a.installed ? "Removing…" : "Installing… — this can take a few minutes"}</span>`
          : a.installed
            ? `<span class="ok">installed</span>${a.version ? ` <span class="ver">${escapeHtml(a.version)}</span>` : ""}
               <button class="mini" data-remove-app="${d.id}" data-app="${a.id}" data-label="${label}"
                 ${running && !anyBusy ? "" : `disabled title="${running ? "Another app change is in progress" : "Start the VM to change apps"}"`}>Remove</button>`
            : `<span class="dim">not installed</span>
               <button class="mini" data-install-app="${d.id}" data-app="${a.id}" data-label="${label}"
                 ${running && !anyBusy ? "" : `disabled title="${running ? "Another app change is in progress" : "Start the VM to install apps"}"`}>Install</button>`}</div>
      </div>`;
    }).join("")}</div>
  </div>`;
}

function paintDetail(d) {
  const stats = $("#detail-stats") || $("#detail-body");
  $("#detail-name").textContent = d.name;
  const state = d.state;
  const r = d.resources;
  const term = d.tmux.clients > 0
    ? `<span class="ok">● ${d.tmux.clients} attached</span>`
    : `<span class="dim">none attached</span>`;

  $("#detail-actions").innerHTML = `
    <button data-term="${d.id}" data-name="${d.name}">${ICON.terminal}Terminal ↗</button>
    <button data-edit="${d.id}" data-name="${d.name}" title="Browse and edit the workdir">${ICON.editor}Editor ↗</button>
    ${d.sync_folder ? `<button data-sync="${d.id}">${ICON.sync}Sync back</button>` : ""}
    ${d.sync_folder ? pushButton(d) : ""}
    <button data-secrets="${d.id}" data-name="${escapeHtml(d.name)}">${ICON.secrets}Vault…</button>
    ${powerButton(d)}
    <button data-rebuild="${d.id}" data-name="${d.name}" data-empty="${d.empty ? 1 : 0}" title="${d.empty ? "Destroy the VM and start an empty one" : "Destroy the VM and recreate it from the original source"}">${ICON.rebuild}Rebuild</button>
    <button class="danger" data-destroy="${d.id}" data-name="${d.name}">${ICON.destroy}Destroy</button>`;

  stats.innerHTML = `
    <div class="detail-grid">
      <div class="panel stat">
        <h3>Status</h3>
        <dl>
          <dt>State</dt><dd><span class="dot ${d.unresponsive ? "error" : state}"></span>${state}${d.unresponsive
            ? ` <span style="color:var(--bad)">· not responding</span> <span class="hint">Stop it, then Start — files are kept</span>` : ""}</dd>
          <dt>Network</dt><dd>${d.net_cutoff
            ? `<span style="color:var(--bad)">internet off</span> <span class="hint">every request refused</span>`
            : d.live?.isolated
            ? `<span class="ok">isolated</span> <span class="hint">no network — proxy only</span>`
            : d.live?.network
              ? `<span style="color:var(--warn)">not isolated</span> <span class="hint">${escapeHtml(d.live.address || d.live.network)} · direct internet — Rebuild to isolate</span>`
              : "—"}</dd>
          <dt>Uptime</dt><dd>${fmtDur(r.uptimeSec)}</dd>
          <dt>Image</dt><dd>${escapeHtml(d.image)}</dd>
          <dt>Active terminal</dt><dd>${term}</dd>
          <dt>tmux</dt><dd>${d.tmux.sessions ?? 0} session · ${d.tmux.windows ?? 0} window(s)</dd>
        </dl>
      </div>

      <div class="panel stat">
        <h3>Resources</h3>
        <dl>
          <dt>CPU</dt><dd>${r.cpuPercent != null ? r.cpuPercent.toFixed(1) + "%" : "—"} of ${r.cpus ?? "?"} vCPU</dd>
          <dt>Memory</dt><dd class="metered">${fmtBytes(r.memoryUsageBytes)} / ${fmtBytes(r.memoryLimitBytes)} ${bar(r.memoryUsageBytes, r.memoryLimitBytes)}
            ${["running", "stopped"].includes(state) && !powerBusy.has(d.id)
              ? `<button class="mini" data-memory="${d.id}" data-name="${d.name}" data-mb="${r.memoryMB ?? ""}" data-running="${state === "running" ? 1 : 0}" title="Give this VM more (or less) memory">Change…</button>` : ""}</dd>
          <dt>Disk</dt><dd class="metered">${fmtBytes(r.diskUsedBytes)} / ${fmtBytes(r.diskTotalBytes)} ${bar(r.diskUsedBytes, r.diskTotalBytes)}</dd>
          <dt>Workdir size</dt><dd>${fmtBytes(r.workdirBytes)}</dd>
          <dt>Processes</dt><dd>${r.numProcesses ?? "—"}</dd>
          <dt>Network</dt><dd>↓ ${fmtBytes(r.networkRxBytes)} · ↑ ${fmtBytes(r.networkTxBytes)}</dd>
        </dl>
      </div>

      <div class="panel stat">
        <h3>Folder & git</h3>
        <dl>
          <dt>Source</dt><dd class="mono">${d.source_path ? escapeHtml(d.source_path) : d.empty ? "none — empty VM" : "git clone"}</dd>
          ${d.empty ? `<dt>Repositories</dt><dd class="dim">cloned in the terminal; the vault's tokens sign git in</dd>` : ""}
          ${d.source_path || d.empty ? "" : `<dt>Local folder</dt><dd>${folderPending?.id === d.id
            ? `<span class="spinner"></span> <span class="dim">${folderPending.label}</span>`
            : d.sync_path
            ? `<span class="mono">${escapeHtml(d.sync_path)}</span>
               <button class="mini" data-link-folder="${d.id}" data-current="${escapeHtml(d.sync_path)}" title="Sync into a different folder">Change</button>
               <button class="mini" data-unlink-folder="${d.id}">Disconnect</button>`
            : `<span class="dim">not connected</span>
               <button class="mini" data-link-folder="${d.id}" title="Pick a local folder (a git repository or any other folder) to sync this project's work into">Connect a folder…</button>`}</dd>`}
          <dt>Workdir (in VM)</dt><dd class="mono">${escapeHtml(d.workdir)}</dd>
          ${d.empty ? "" : `<dt>Work branch</dt><dd class="mono">${escapeHtml(d.branch)}</dd>
          <dt>Uncommitted</dt><dd>${d.git.dirty ?? 0} file(s)</dd>
          <dt>Git remote</dt><dd>${d.git_remote
            ? `<span class="mono">${escapeHtml(d.git_remote)}${d.has_git_token ? " 🔑" : ""}</span>`
            : `<span class="dim">none</span>`}
            <button class="mini" data-git-remote="${d.id}" data-name="${escapeHtml(d.name)}" data-current="${escapeHtml(d.git_remote || "")}"
              data-token="${d.has_git_token ? 1 : 0}" data-cloned="${d.source_path ? 0 : 1}"
              ${state === "running" ? "" : `disabled title="Start the VM to change its git remote"`}>${d.git_remote ? "Change" : "Connect a remote…"}</button></dd>`}
        </dl>
      </div>

      <div class="panel stat">
        <h3>Installed tools</h3>
        <div class="toolchain">${
          state === "running"
            ? (d.toolchain ? toolchainHtml(d.toolchain) : `<span class="hint">${d.partial ? "checking…" : "could not probe"}</span>`)
            : `<span class="hint">start the VM to detect</span>`
        }</div>
        <dl><dt>Extra apt</dt><dd>${d.apps.length ? d.apps.map(escapeHtml).join(", ") : "none"}</dd></dl>
      </div>
    </div>
    ${optionalAppsHtml(d)}
    ${d.error ? `<div class="panel" style="color:var(--bad)">${escapeHtml(d.error)}</div>` : ""}`;
}

// ---- port forwards panel (host port → VM port) ----
async function openPorts(id) {
  const el = $("#detail-ports");
  if (!el) return;
  el.innerHTML = `
  <div class="panel net-panel">
    <div class="net-head"><h3>Port forwards</h3></div>
    <div class="net-section">
      <div class="net-subhead">Open an app running in the VM <span class="hint">any app listening on that port in the VM, on localhost or 0.0.0.0</span></div>
      <div id="port-list"></div>
      <form id="port-add" class="net-form">
        <input name="guestPort" type="number" min="1" max="65535" placeholder="VM port (e.g. 8000)" required>
        <span class="hint">→</span>
        <input name="hostPort" type="number" min="1024" max="65535" placeholder="port on this host" required>
        <label class="hint" title="Raw TCP that anyone who reaches this machine can use: for databases and other non-HTTP servers, or an API called from another forward's browser code. Otherwise the port is HTTP for a browser signed in to sadbox only."><input name="open" type="checkbox"> open to anyone</label>
        <button type="submit">Forward</button>
      </form>
    </div>
  </div>`;
  el.addEventListener("click", async (e) => {
    const acc = e.target.closest("[data-port-access]");
    if (acc) {
      const open = acc.dataset.portAccess === "open";
      if (open && !confirm("Open this port to anyone who can reach this machine, without signing in?")) return;
      try { await api(`/api/projects/${id}/forwards/${acc.dataset.portId}`, { method: "PATCH", body: { access: acc.dataset.portAccess } }); }
      catch (err) { alert(err.message); }
      renderPorts(id);
      return;
    }
    const del = e.target.closest("[data-del-port]");
    if (!del) return;
    try { await api(`/api/projects/${id}/forwards/${del.dataset.delPort}`, { method: "DELETE" }); } catch {}
    renderPorts(id);
  });
  el.querySelector("#port-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api(`/api/projects/${id}/forwards`, {
        method: "POST",
        body: { guestPort: Number(f.get("guestPort")), hostPort: Number(f.get("hostPort")), access: f.get("open") ? "open" : "signin" },
      });
      e.target.reset(); renderPorts(id);
    } catch (err) { alert(err.message); }
  });
  renderPorts(id);
}

async function renderPorts(id) {
  const el = $("#port-list");
  if (!el) return;
  let data;
  try { data = await api(`/api/projects/${id}/forwards`); }
  catch (e) { el.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }
  if (!data.forwards.length) { el.innerHTML = `<div class="empty">no ports forwarded</div>`; return; }
  el.innerHTML = data.forwards.map((f) => {
    // a sign-in forward is opened through the UI, which hands the browser its pass
    const url = f.access === "open" ? `http://${location.hostname}:${f.host_port}` : `/forwards/${f.id}/open`;
    const other = f.access === "open" ? "signin" : "open";
    return `<div class="rule">
      <span class="ract ${f.active ? "allow" : "block"}">${f.active ? "up" : "down"}</span>
      <span class="rspec"><a href="${url}" target="_blank" rel="noopener">${escapeHtml(location.hostname)}:${f.host_port}</a> → VM port ${f.guest_port}${
        f.active ? "" : ` <span class="hint">host port was in use at startup</span>`}</span>
      <button class="link-del" data-port-id="${f.id}" data-port-access="${other}" title="${f.access === "open"
        ? "Open to anyone who reaches this machine (raw TCP). Click to require sign-in."
        : "HTTP, for a browser signed in to sadbox only. Click to open it to anyone."}">${f.access === "open" ? "🔓 anyone" : "🔒 sign-in"}</button>
      <button class="link-del" data-del-port="${f.id}" title="remove">✕</button>
    </div>`;
  }).join("");
}

// ---- links panel (this VM may reach one port of another project's VM) ----
async function openLinks(id) {
  const el = $("#detail-links");
  if (!el) return;
  el.innerHTML = `
  <div class="panel net-panel">
    <div class="net-head"><h3>Links to other projects</h3></div>
    <div class="net-section">
      <div class="net-subhead">This project can reach <span class="hint">from inside this VM, at the address shown — over HTTP(S), one port each; every other port and project stays closed</span></div>
      <div id="link-out"></div>
      <form id="link-add" class="net-form">
        <select name="to" required><option value="">project…</option></select>
        <input name="port" type="number" min="1" max="65535" placeholder="its port (e.g. 3000)" required>
        <button type="submit">Allow</button>
      </form>
    </div>
    <div class="net-section">
      <div class="net-subhead">Can be reached from <span class="hint">links other projects have to this one; this VM gets no access back</span></div>
      <div id="link-in"></div>
    </div>
  </div>`;
  el.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del-link]");
    if (!del) return;
    try { await api(`/api/projects/${id}/links/${del.dataset.delLink}`, { method: "DELETE" }); } catch {}
    renderLinks(id);
  });
  el.querySelector("#link-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api(`/api/projects/${id}/links`, { method: "POST", body: { to: f.get("to"), port: Number(f.get("port")) } });
      e.target.reset(); renderLinks(id);
    } catch (err) { alert(err.message); }
  });
  try {
    const others = (await api("/api/projects")).filter((p) => p.id !== id);
    el.querySelector("select[name=to]").innerHTML = others.length
      ? `<option value="">project…</option>` + others.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("")
      : `<option value="">no other projects</option>`;
  } catch {}
  renderLinks(id);
}

async function renderLinks(id) {
  const out = $("#link-out"), inc = $("#link-in");
  if (!out || !inc) return;
  let data;
  try { data = await api(`/api/projects/${id}/links`); }
  catch (e) { out.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }
  out.innerHTML = data.outgoing.length ? data.outgoing.map((l) => `<div class="rule">
      <span class="ract allow">reach</span>
      <span class="rspec"><code class="link-addr">http://${escapeHtml(l.host)}</code> → <a href="#project/${l.project}">${escapeHtml(l.name)}</a> port ${l.port}</span>
      <button class="link-del" data-del-link="${l.id}" title="remove">✕</button>
    </div>`).join("") : `<div class="empty">no links — this VM cannot reach any other project</div>`;
  inc.innerHTML = data.incoming.length ? data.incoming.map((l) => `<div class="rule">
      <span class="ract allow">from</span>
      <span class="rspec"><a href="#project/${l.project}">${escapeHtml(l.name)}</a> → this VM's port ${l.port}</span>
      <button class="link-del" data-del-link="${l.id}" title="remove">✕</button>
    </div>`).join("") : `<div class="empty">no project can reach this one</div>`;
}

// ---- network activity panel (per-project egress proxy) ----
let netES = null;
let netId = null;
let netModel = { requests: [], pending: [], rules: [], headerRules: [], cutoff: false, isolated: null, older: [], noOlder: false, summary: null };
const DUR_OPTS = [["once", "once"], ["1m", "1 min"], ["5m", "5 min"], ["30m", "30 min"], ["60m", "60 min"], ["forever", "forever"]];

function openNet(id) {
  closeNet();
  netId = id;
  netModel = { requests: [], pending: [], rules: [], headerRules: [], cutoff: false, isolated: null, older: [], noOlder: false, summary: null };
  const el = $("#detail-net");
  if (!el) return;
  el.innerHTML = netShellHtml();
  bindNetHandlers(el);
  renderPending(); renderLog(); renderRules(); renderHeaders(); renderCutoff();
  connectNetStream(id);
  // vault items available as header values
  refreshVault().catch(() => {}).then(() => { if (netId === id) syncHeaderForm(); });
}

// show/hide the header-form value vs. secret picker based on op + source + scope
function syncHeaderForm() {
  const form = $("#net-header-add");
  if (!form) return;
  const isSet = form.op.value === "set";
  const useSecret = form.valueSource.value === "secret";
  form.valueSource.hidden = !isSet;
  form.value.hidden = !isSet || useSecret;
  form.valueSecretId.hidden = !isSet || !useSecret;
  if (isSet && useSecret) form.valueSecretId.innerHTML = headerSecretOptions(form.scope.value);
}

// a project rule can use the items this project may use; a global rule any
// item (it fills the header only in projects that may use it)
function headerSecretOptions(scope) {
  const items = (vaultCache || []).filter((s) => scope !== "project" || s.projectIds.includes(netId));
  const opts = items.map((s) => `<option value="${s.id}">${escapeHtml(s.name)} · ${s.kind}</option>`).join("");
  return `<option value="">— pick a vault item —</option>${opts}`;
}

function closeNet() {
  if (netES) { try { netES.close(); } catch {} netES = null; }
  netId = null;
}

function connectNetStream(id) {
  const es = new EventSource(`/api/projects/${id}/net/stream`);
  netES = es;
  setNetStatus("connecting…", "");
  es.onopen = () => setNetStatus("● live", "on");
  es.onerror = () => setNetStatus("reconnecting…", "off");
  es.onmessage = (e) => {
    if (netId !== id) return;
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === "snapshot") {
      netModel.requests = ev.requests || [];
      netModel.pending = ev.pending || [];
      netModel.rules = ev.rules || [];
      netModel.headerRules = ev.headerRules || [];
      netModel.cutoff = !!ev.cutoff;
      renderPending(); renderLog(); renderRules(); renderHeaders(); renderCutoff();
    } else if (ev.type === "request") {
      netModel.requests.push(ev.entry);
      if (netModel.requests.length > 500) netModel.requests.shift();
      summaryStale();
      renderLog();
    } else if (ev.type === "pending") {
      if (!netModel.pending.some((p) => p.id === ev.pending.id)) netModel.pending.push(ev.pending);
      renderPending(); refreshNavTree();
    } else if (ev.type === "pending-resolved") {
      netModel.pending = netModel.pending.filter((p) => p.id !== ev.id);
      renderPending(); refreshNavTree();
      reloadNetRules(); // a timed/forever answer may have created a rule
    } else if (ev.type === "cutoff") {
      netModel.cutoff = ev.on; renderCutoff(); // switched here, in another tab, or over the API
    }
  };
}

function setNetStatus(text, cls) {
  const s = $("#net-status");
  if (s) { s.textContent = text; s.className = "net-live " + cls; }
}

async function reloadNetRules() {
  if (!netId) return;
  try {
    const [rules, headers] = await Promise.all([
      api(`/api/projects/${netId}/net/rules`),
      api(`/api/projects/${netId}/net/headers`),
    ]);
    netModel.rules = rules; netModel.headerRules = headers;
    renderRules(); renderHeaders(); renderLog(); // log's "allowed" markers derive from rules
  } catch {}
}

// UI state for the Network panel, remembered per browser (a convenience only)
const NET_UI_KEY = "sadbox.net.ui";
let netUi = { tab: "activity", mode: "hosts", range: "recent", filter: "", blockedOnly: false, showExpired: false };
try { Object.assign(netUi, JSON.parse(localStorage.getItem(NET_UI_KEY) || "{}"), { filter: "" }); } catch {}
const saveNetUi = () => { try { localStorage.setItem(NET_UI_KEY, JSON.stringify({ ...netUi, filter: undefined })); } catch {} };

function netShellHtml() {
  const tab = (id, label) => `<button type="button" class="net-tab${netUi.tab === id ? " on" : ""}" data-net-tab="${id}">${label} <span class="net-count" id="net-count-${id}"></span></button>`;
  return `
  <div class="panel net-panel net-main">
    <div class="net-head">
      <h3>Network</h3>
      <span id="net-status" class="net-live">connecting…</span>
      <span class="grow"></span>
      <label class="net-switch" id="net-switch" title="Cut this VM off from every network, or let it out again (rules apply)">
        <input type="checkbox" id="net-online" checked>
        <span class="track"><span class="knob"></span></span>
        <span id="net-online-label">Internet on</span>
      </label>
      <a class="net-ca" href="/api/net/ca" download title="Trust this CA to inspect traffic outside a VM">Download CA</a>
    </div>
    <div id="net-cutoff-banner" class="net-banner" hidden>
      <b>Internet is off.</b> Every request from this VM is refused — rules, approvals and secrets are not consulted.
    </div>
    <div id="net-isolation-note" class="net-banner warn" hidden>
      This VM still has a direct network route (created before isolation), so the switch can't stop all of its
      traffic. <b>Rebuild</b> it to put it behind the proxy.
    </div>
    <div id="net-pending"></div>
    <div class="net-tabs" role="tablist">
      ${tab("activity", "Activity")}${tab("rules", "Rules")}${tab("headers", "Header rules")}
    </div>

    <div class="net-pane" data-pane="activity"${netUi.tab === "activity" ? "" : " hidden"}>
      <div class="net-tools">
        <div class="seg" role="group">
          <button type="button" data-net-mode="hosts" class="${netUi.mode === "hosts" ? "on" : ""}">By host</button>
          <button type="button" data-net-mode="requests" class="${netUi.mode === "requests" ? "on" : ""}">All requests</button>
        </div>
        <select id="net-range" title="By host over the live window, or over the stored log"${netUi.mode === "hosts" ? "" : " hidden"}>
          <option value="recent"${netUi.range === "recent" ? " selected" : ""}>recent</option>
          <option value="24h"${netUi.range === "24h" ? " selected" : ""}>last 24 hours</option>
          <option value="7d"${netUi.range === "7d" ? " selected" : ""}>last 7 days</option>
        </select>
        <input id="net-filter" type="search" placeholder="filter host or path">
        <label class="net-chk"><input type="checkbox" id="net-blocked-only"${netUi.blockedOnly ? " checked" : ""}> blocked only</label>
        <span class="grow"></span>
        <span id="net-activity-note" class="hint"></span>
      </div>
      <div class="net-log-wrap"><table class="net-log" id="net-activity"></table></div>
      <button type="button" class="link-add" id="net-older" hidden>load older requests</button>
    </div>

    <div class="net-pane" data-pane="rules"${netUi.tab === "rules" ? "" : " hidden"}>
      <form id="net-rule-add" class="net-form">
        <select name="action"><option value="allow">allow</option><option value="block">block</option></select>
        <input name="host" placeholder="host — api.github.com, *.github.com, *" required>
        <input name="path" placeholder="path glob (optional)">
        <select name="scope"><option value="project">this project</option><option value="global">all projects</option></select>
        <button class="primary" type="submit">Add rule</button>
      </form>
      <p class="hint net-howto">Block wins over allow. A host no rule covers waits for your approval.</p>
      <div id="net-rules"></div>
    </div>

    <div class="net-pane" data-pane="headers"${netUi.tab === "headers" ? "" : " hidden"}>
      <form id="net-header-add" class="net-form">
        <select name="direction"><option value="request">request</option><option value="response">response</option></select>
        <select name="op"><option value="set">set</option><option value="remove">remove</option></select>
        <input name="host" placeholder="host" required>
        <input name="header" placeholder="Header-Name (e.g. Authorization)" required>
        <select name="valueSource"><option value="literal">value</option><option value="secret">from secret</option></select>
        <input name="value" placeholder="value">
        <select name="valueSecretId" hidden></select>
        <select name="scope"><option value="project">this project</option><option value="global">all projects</option></select>
        <button class="primary" type="submit">Add</button>
      </form>
      <p class="hint net-howto">Set or remove a header on requests to (or responses from) a host. To give a VM a token
        without it ever seeing the value, prefer a <a href="#secrets">secret delivered via the proxy</a>.</p>
      <div id="net-headers"></div>
    </div>
  </div>`;
}

// ---- cutoff switch ----
function renderCutoff() {
  const on = !netModel.cutoff;
  const cb = $("#net-online");
  if (!cb) return;
  cb.checked = on;
  cb.disabled = netModel.isolated === false; // a direct-route VM can't be cut off at the proxy
  $("#net-online-label").textContent = on ? "Internet on" : "Internet off";
  $("#net-switch").classList.toggle("off", !on);
  $("#net-cutoff-banner").hidden = on;
  $("#net-isolation-note").hidden = netModel.isolated !== false;
}

/** Told by the detail view whether the VM is behind the proxy only (null: unknown). */
function setNetIsolation(isolated) {
  netModel.isolated = isolated;
  renderCutoff();
}

async function toggleCutoff(cb) {
  const cutoff = !cb.checked;
  cb.disabled = true;
  try {
    const r = await api(`/api/projects/${netId}/network`, { method: "PUT", body: { cutoff } });
    netModel.cutoff = r.cutoff;
  } catch (err) { alert(err.message); }
  cb.disabled = false;
  renderCutoff();
}

// ---- tabs ----
function setNetTab(tab) {
  netUi.tab = tab; saveNetUi();
  for (const b of document.querySelectorAll("[data-net-tab]")) b.classList.toggle("on", b.dataset.netTab === tab);
  for (const p of document.querySelectorAll(".net-pane")) p.hidden = p.dataset.pane !== tab;
}

function renderNetCounts() {
  const set = (id, n, alert) => { const el = $(`#net-count-${id}`); if (el) { el.textContent = n || ""; el.classList.toggle("alert", !!alert); } };
  const hosts = new Set(netModel.requests.map((r) => r.host));
  const blocked = new Set(netModel.requests.filter((r) => r.decision === "blocked").map((r) => r.host));
  set("activity", hosts.size, false);
  set("rules", activeRules().length);
  set("headers", netModel.headerRules.length);
  const note = $("#net-count-activity");
  if (note) note.title = `${hosts.size} hosts · ${blocked.size} with blocked requests`;
}

function renderPending() {
  const el = $("#net-pending");
  if (!el) return;
  if (!netModel.pending.length) { el.innerHTML = ""; return; }
  el.innerHTML = netModel.pending.map((p) => {
    // clicking a duration is the answer itself; "forever" would bind a
    // credential to the host for good, so it is not offered for one
    const opts = DUR_OPTS.filter(([v]) => !(p.credential && v === "forever"))
      .map(([v, l]) => `<button class="durbtn" data-approve-duration="${v}" title="Allow for ${l}">${l}</button>`).join("");
    // a credential ask: send this proxy secret to a host none of its bindings name?
    const cred = p.fetch
      ? `<div class="approval-cred">🔒 wants to read <b>${escapeHtml(p.fetch.name)}</b> from the vault — the VM gets the real value</div>`
      : p.credential
      ? `<div class="approval-cred">🔑 sends <b>${escapeHtml(p.credential.name)}</b> to this host — allowing binds the secret to it</div>`
      : "";
    return `<div class="approval${p.credential || p.fetch ? " cred" : ""}" data-aid="${p.id}">${cred}
      <div class="approval-req">
        <span class="badge">${p.scheme}</span>
        <b>${escapeHtml(p.method)}</b>
        <span class="host">${escapeHtml(p.host)}</span><span class="path">${escapeHtml(p.path)}</span>
      </div>
      <div class="approval-actions">
        <span class="hint">Allow for</span>${opts}
        <button class="danger" data-block>Block</button>
      </div>
    </div>`;
  }).join("");
}

// ---- rule coverage, client side (same matching as the proxy: exact, *.suffix, *) ----
const ruleLive = (r, now = Date.now()) => !r.expires_at || Date.parse(r.expires_at) > now;
const activeRules = () => netModel.rules.filter((r) => ruleLive(r));
function hostCovers(pattern, host) {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) { const bare = pattern.slice(2); return host === bare || host.endsWith("." + bare); }
  return pattern === host;
}
/** How a host is treated by rules alone (host-wide rules; path/method rules don't count). */
function hostAccess(host) {
  const m = activeRules().filter((r) => !r.path && !r.method && hostCovers(r.host, host));
  const block = m.find((r) => r.action === "block");
  if (block) return { kind: "blocked", rule: block };
  const own = m.find((r) => r.action === "allow" && r.scope === "project" && r.source !== "vault");
  const glob = m.find((r) => r.action === "allow" && r.scope === "global");
  // a proxy vault item allows the hosts it is bound to, after the rules people wrote
  const vault = m.find((r) => r.action === "allow" && r.source === "vault");
  if (own || glob || vault) return { kind: "allowed", rule: own || glob || vault };
  return { kind: "ask" };
}

// ---- activity: by host (default) or every request ----
let activityQueued = false;
function renderLog() { // (kept name: called whenever requests or rules change)
  if (activityQueued) return;
  activityQueued = true;
  requestAnimationFrame(() => { activityQueued = false; renderActivity(); renderNetCounts(); });
}

const RANGE_MS = { "24h": 86_400_000, "7d": 7 * 86_400_000 };
const RANGE_LABEL = { "24h": "in the last 24 hours", "7d": "in the last 7 days" };
const fmtCount = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function activityRows() {
  const q = netUi.filter.trim().toLowerCase();
  return [...netModel.older, ...netModel.requests].filter((r) =>
    (!netUi.blockedOnly || r.decision === "blocked") &&
    (!q || (r.host + r.path).toLowerCase().includes(q)));
}

/** Per-host groups: from the live rows, or (24h / 7d) from the stored log's summary. */
function hostGroups() {
  const q = netUi.filter.trim().toLowerCase();
  if (netUi.range !== "recent") {
    return (netModel.summary || [])
      .filter((h) => (!netUi.blockedOnly || h.blocked) && (!q || h.host.toLowerCase().includes(q)))
      .map((h) => ({ host: h.host, n: h.requests, ok: h.ok, err: h.errors, blocked: h.blocked, last: h.last,
        creds: new Set(h.credentials), lastErr: h.lastError || "" }));
  }
  const by = new Map();
  for (const r of activityRows()) {
    let g = by.get(r.host);
    if (!g) by.set(r.host, g = { host: r.host, n: 0, ok: 0, err: 0, blocked: 0, last: 0, creds: new Set(), lastErr: "" });
    g.n++; g.last = Math.max(g.last, r.ts);
    if (r.decision === "blocked") { g.blocked++; if (r.error) g.lastErr = r.error; }
    else if (r.status != null && r.status < 400) g.ok++; else g.err++;
    for (const c of r.credentials || []) g.creds.add(c);
  }
  return [...by.values()].sort((a, b) => b.last - a.last);
}

function renderActivity() {
  const el = $("#net-activity");
  if (!el) return;
  const byHost = netUi.mode === "hosts";
  $("#net-range").hidden = !byHost;
  const older = $("#net-older");
  older.hidden = byHost || netModel.noOlder || !netModel.requests.length;
  if (byHost && netUi.range !== "recent" && !netModel.summary) {
    loadSummary();
    el.innerHTML = `<tbody><tr><td class="empty">loading…</td></tr></tbody>`;
    return;
  }
  const groups = byHost ? hostGroups() : null;
  const rows = byHost ? null : activityRows();
  const shown = byHost ? groups.length : rows.length;
  if (byHost && netUi.range !== "recent") {
    const total = (netModel.summary || []).reduce((a, h) => a + h.requests, 0);
    $("#net-activity-note").textContent = `${fmtCount(total, "request")} to ${fmtCount((netModel.summary || []).length, "host")} ${RANGE_LABEL[netUi.range]}`;
  } else {
    const total = netModel.older.length + netModel.requests.length;
    $("#net-activity-note").textContent = total ? `${byHost ? fmtCount(shown, "host") + " · " : ""}${fmtCount(total, "recent request")}` : "";
  }
  if (!shown) {
    const any = netModel.requests.length || (netModel.summary || []).length;
    el.innerHTML = `<tbody><tr><td class="empty">${any ? "nothing matches" : "no requests yet — traffic from the VM shows up here live"}</td></tr></tbody>`;
    return;
  }
  el.innerHTML = byHost ? hostsTable(groups) : requestsTable(rows);
}

// stored-log summary for 24h / 7d: fetched on demand, refreshed (at most every 5 s) as traffic arrives
let summaryAt = 0, summaryTimer = null;
async function loadSummary() {
  const range = netUi.range, id = netId;
  if (range === "recent" || !id) return;
  summaryAt = Date.now();
  try {
    const s = await api(`/api/projects/${id}/net/hosts?since=${Date.now() - RANGE_MS[range]}`);
    if (netId === id && netUi.range === range) { netModel.summary = s; renderActivity(); renderNetCounts(); }
  } catch {}
}
function summaryStale() {
  if (netUi.range === "recent" || netUi.mode !== "hosts") { netModel.summary = null; return; }
  if (summaryTimer) return;
  summaryTimer = setTimeout(() => { summaryTimer = null; loadSummary(); }, Math.max(0, 5000 - (Date.now() - summaryAt)));
}

async function loadOlder(btn) {
  const first = netModel.older[0] || netModel.requests[0];
  if (!first) return;
  btn.disabled = true;
  try {
    const { requests } = await api(`/api/projects/${netId}/net/requests?before=${first.ts}&limit=200`);
    const seen = new Set([...netModel.older, ...netModel.requests].map((r) => r.id));
    const fresh = requests.filter((r) => !seen.has(r.id));
    netModel.older = [...fresh, ...netModel.older];
    if (requests.length < 200) netModel.noOlder = true;
    renderActivity();
  } catch (err) { alert(err.message); }
  btn.disabled = false;
}

function accessCell(host) {
  const a = hostAccess(host);
  if (a.kind === "blocked") return `<span class="acc blocked" title="block rule ${escapeHtml(a.rule.host)}">blocked · ${a.rule.scope === "global" ? "all projects" : "this project"}</span>`;
  if (a.kind === "allowed") {
    const exp = a.rule.expires_at ? ` until ${fmtClock(Date.parse(a.rule.expires_at))}` : "";
    const via = a.rule.host !== host ? ` via ${escapeHtml(a.rule.host)}` : "";
    if (a.rule.source === "vault") {
      return `<span class="acc allowed" title="allowed because vault item ${escapeHtml(a.rule.secret_name)} is bound to ${escapeHtml(a.rule.host)}">allowed · 🔑 ${escapeHtml(a.rule.secret_name)}</span><span class="hint">${via}${exp}</span>`;
    }
    return `<span class="acc allowed" title="allow rule ${escapeHtml(a.rule.host)}${exp}">allowed · ${a.rule.scope === "global" ? "all projects" : "this project"}</span><span class="hint">${via}${exp}</span>`;
  }
  return `<span class="acc ask" title="no rule — each new request waits for approval">asks</span>`;
}

function hostActions(host) {
  const a = hostAccess(host);
  const h = escapeHtml(host);
  const btn = (attrs, label, title) => `<button type="button" class="mini" ${attrs} title="${title}">${label}</button>`;
  if (a.kind === "allowed" && a.rule.source === "vault") {
    return btn(`data-host-rule="block" data-host="${h}" data-scope="project"`, "Block", `Block ${h} for this project`);
  }
  if (a.kind === "allowed") {
    // this project's allow rule can be widened to every project, and a global one narrowed to this project
    return a.rule.host === host
      ? btn(`data-move-rule="${a.rule.id}" data-to="${a.rule.scope === "global" ? "project" : "global"}"`,
          a.rule.scope === "global" ? "→ this project" : "→ all projects",
          a.rule.scope === "global" ? `Allow ${h} for this project only` : `Allow ${h} for every project`)
        + btn(`data-host-rule="block" data-host="${h}" data-scope="project"`, "Block", `Block ${h} for this project`)
      : btn(`data-host-rule="block" data-host="${h}" data-scope="project"`, "Block", `Block ${h} for this project`);
  }
  if (a.kind === "blocked") return a.rule.host === host ? btn(`data-del-rule="${a.rule.id}"`, "Unblock", `Remove the block rule for ${h}`) : "";
  return btn(`data-host-rule="allow" data-host="${h}" data-scope="project"`, "Allow", `Allow ${h} for this project`)
    + btn(`data-host-rule="allow" data-host="${h}" data-scope="global"`, "Allow for all", `Allow ${h} for every project`);
}

// a time of day, with the date in front once it isn't today (the log keeps a week)
const fmtWhen = (ts) => new Date(ts).toDateString() === new Date().toDateString() ? fmtClock(ts)
  : `${new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${fmtClock(ts).slice(0, 5)}`;

function hostsTable(groups) {
  return `<thead><tr><th>host</th><th class="num">requests</th><th>results</th><th>access</th><th>last</th><th></th></tr></thead>
    <tbody>${groups.map((g) => {
      const res = [g.ok && `<span class="s2xx">${g.ok} ok</span>`, g.err && `<span class="s4xx">${g.err} error</span>`,
        g.blocked && `<span class="sblk" title="${escapeHtml(g.lastErr)}">${g.blocked} blocked</span>`].filter(Boolean).join(" · ");
      const creds = [...g.creds].map((n) => `<span class="cchip in" title="real value swapped in by the proxy">🔑 ${escapeHtml(n)}</span>`).join("");
      return `<tr class="${g.blocked && !g.ok ? "dec-blocked" : ""}">
        <td class="np"><span class="host">${escapeHtml(g.host)}</span>${creds}</td>
        <td class="mono num">${g.n}</td>
        <td class="res">${res}</td>
        <td class="acc-cell">${accessCell(g.host)}</td>
        <td class="mono">${fmtWhen(g.last)}</td>
        <td class="rowact">${hostActions(g.host)}</td>
      </tr>`;
    }).join("")}</tbody>`;
}

function requestsTable(rows) {
  // the live window, plus whatever older pages were loaded
  const shown = rows.slice(-(150 + netModel.older.length)).reverse();
  return `<thead><tr><th>time</th><th>method</th><th>host / path</th><th>status</th><th>decision</th><th class="num">size</th></tr></thead>
    <tbody>${shown.map((r) => {
      const s = r.status;
      const sc = s == null ? "" : s >= 500 ? "s5xx" : s >= 400 ? "s4xx" : s >= 300 ? "s3xx" : "s2xx";
      return `<tr class="dec-${r.decision}">
        <td class="mono">${fmtWhen(r.ts)}</td>
        <td>${escapeHtml(r.method)}</td>
        <td class="np"><span class="host">${escapeHtml(r.host)}</span><span class="path">${escapeHtml(r.path)}</span>${credChips(r)}</td>
        <td class="mono ${sc}">${s ?? "—"}</td>
        <td><span class="decb ${r.decision}"${r.error ? ` title="${escapeHtml(r.error)}"` : ""}>${r.decision}</span></td>
        <td class="mono num">${fmtBytes(r.respBytes)}</td>
      </tr>`;
    }).join("")}</tbody>`;
}

// proxy secrets on a log row: swapped in, scrubbed from the response, or seen in the URL
function credChips(r) {
  const chip = (cls, icon, names, title) => (names || []).map((n) =>
    `<span class="cchip ${cls}" title="${title}">${icon} ${escapeHtml(n)}</span>`).join("");
  return chip("in", "🔑", r.credentials, "real value swapped in by the proxy")
    + chip("red", "⇄", r.redacted, "real value scrubbed from the response headers")
    + chip("url", "⚠", r.credentialInUrl, "placeholder in the URL — never swapped");
}

// ---- rules: this project's and every project's, each movable to the other side ----
function ruleRow(r) {
  const live = ruleLive(r);
  const exp = r.expires_at ? ` <span class="hint">${live ? "until" : "expired"} ${fmtClock(Date.parse(r.expires_at))}</span>` : "";
  const parts = [r.host];
  if (r.path) parts.push("path:" + r.path);
  if (r.method) parts.push(r.method);
  if (r.source === "vault") {
    // derived from a proxy vault item's binding: it goes when the binding or the access does
    return `<div class="rule${live ? "" : " expired"}">
    <span class="ract ${r.action}">${r.action}</span>
    <span class="rspec">${escapeHtml(parts.join(" · "))}${exp}</span>
    <span class="rsrc" title="Allowed because vault item ${escapeHtml(r.secret_name)} is bound to this host. Remove the binding, or this project's access to the item, to take it away.">🔑 vault · ${escapeHtml(r.secret_name)}</span>
  </div>`;
  }
  const move = r.scope === "global"
    ? `<button type="button" class="mini" data-move-rule="${r.id}" data-to="project" title="Make this rule apply to this project only">→ this project</button>`
    : `<button type="button" class="mini" data-move-rule="${r.id}" data-to="global" title="Make this rule apply to every project">→ all projects</button>`;
  return `<div class="rule${live ? "" : " expired"}">
    <span class="ract ${r.action}">${r.action}</span>
    <span class="rspec">${escapeHtml(parts.join(" · "))}${exp}</span>
    ${live ? move : ""}
    <button class="link-del" data-del-rule="${r.id}" title="delete">✕</button>
  </div>`;
}

function renderRules() {
  const el = $("#net-rules");
  if (!el) return;
  const now = Date.now();
  const expired = netModel.rules.filter((r) => !ruleLive(r, now));
  const shown = netUi.showExpired ? netModel.rules : netModel.rules.filter((r) => ruleLive(r, now));
  // allow before block, then by host, so a long list reads like a list
  const order = (a, b) => a.action.localeCompare(b.action) || a.host.localeCompare(b.host);
  const group = (title, hint, rules) => `<div class="rule-group">
    <div class="net-subhead">${title} <span class="hint">${hint}</span></div>
    ${rules.length ? rules.sort(order).map(ruleRow).join("") : `<div class="empty">none</div>`}
  </div>`;
  el.innerHTML =
    group("This project", "only this VM", shown.filter((r) => r.scope !== "global"))
    + group("All projects", "global — every VM", shown.filter((r) => r.scope === "global"))
    + (expired.length ? `<button type="button" class="link-add" data-toggle-expired>${netUi.showExpired ? "hide" : "show"} ${expired.length} expired</button>` : "");
  renderNetCounts();
}

function renderHeaders() {
  const el = $("#net-headers");
  if (!el) return;
  if (!netModel.headerRules.length) { el.innerHTML = `<div class="empty">no header rules</div>`; renderNetCounts(); return; }
  el.innerHTML = netModel.headerRules.map((r) => {
    let spec;
    if (r.op !== "set") spec = `remove ${escapeHtml(r.header)}`;
    else if (r.value_secret_id) spec = `${escapeHtml(r.header)} ← <span class="secref">🔑 ${escapeHtml(r.value_secret_name || "secret")}</span>`;
    else spec = `${escapeHtml(r.header)}: ${escapeHtml(r.value || "")}`;
    return `<div class="rule">
      <span class="ract ${r.direction === "request" ? "allow" : "block"}">${r.direction}</span>
      <span class="rscope">${r.scope === "global" ? "all projects" : "this project"}</span>
      <span class="rspec">${escapeHtml(r.host)} · ${spec}</span>
      <button class="link-del" data-del-header="${r.id}" title="delete">✕</button>
    </div>`;
  }).join("");
  renderNetCounts();
}

function bindNetHandlers(el) {
  el.addEventListener("click", async (e) => {
    const appr = e.target.closest(".approval");
    const allow = e.target.closest("[data-approve-duration]");
    if (appr && allow) {
      return sendApproval(appr.dataset.aid, "allow", allow.dataset.approveDuration);
    }
    if (appr && e.target.closest("[data-block]")) {
      // a credential block refuses this request only (no rule) — the host itself stays reachable
      const cred = appr.classList.contains("cred");
      return sendApproval(appr.dataset.aid, "block", cred ? "once" : "forever");
    }
    const tab = e.target.closest("[data-net-tab]");
    if (tab) return setNetTab(tab.dataset.netTab);
    const mode = e.target.closest("[data-net-mode]");
    if (mode) {
      netUi.mode = mode.dataset.netMode; saveNetUi();
      for (const b of el.querySelectorAll("[data-net-mode]")) b.classList.toggle("on", b === mode);
      return renderActivity();
    }
    if (e.target.closest("[data-toggle-expired]")) { netUi.showExpired = !netUi.showExpired; saveNetUi(); return renderRules(); }
    const hr = e.target.closest("[data-host-rule]");
    if (hr) {
      const base = hr.dataset.scope === "global" ? "/api/net/rules" : `/api/projects/${netId}/net/rules`;
      hr.disabled = true;
      try { await api(base, { method: "POST", body: { action: hr.dataset.hostRule, host: hr.dataset.host } }); await reloadNetRules(); }
      catch (err) { hr.disabled = false; alert(err.message); }
      return;
    }
    const mv = e.target.closest("[data-move-rule]");
    if (mv) {
      mv.disabled = true;
      try { await api(`/api/projects/${netId}/net/rules/${mv.dataset.moveRule}`, { method: "PATCH", body: { scope: mv.dataset.to } }); await reloadNetRules(); }
      catch (err) { mv.disabled = false; alert(err.message); }
      return;
    }
    const dr = e.target.closest("[data-del-rule]");
    if (dr) { try { await api(`/api/net/rules/${dr.dataset.delRule}`, { method: "DELETE" }); } catch {} return reloadNetRules(); }
    const dh = e.target.closest("[data-del-header]");
    if (dh) { try { await api(`/api/net/headers/${dh.dataset.delHeader}`, { method: "DELETE" }); } catch {} return reloadNetRules(); }
  });
  el.querySelector("#net-online").addEventListener("change", (e) => toggleCutoff(e.target));
  el.querySelector("#net-filter").addEventListener("input", (e) => { netUi.filter = e.target.value; renderActivity(); });
  el.querySelector("#net-range").addEventListener("change", (e) => {
    netUi.range = e.target.value; saveNetUi(); netModel.summary = null; renderActivity();
  });
  el.querySelector("#net-older").addEventListener("click", (e) => loadOlder(e.target));
  el.querySelector("#net-blocked-only").addEventListener("change", (e) => { netUi.blockedOnly = e.target.checked; saveNetUi(); renderActivity(); });
  el.querySelector("#net-rule-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const base = f.get("scope") === "global" ? "/api/net/rules" : `/api/projects/${netId}/net/rules`;
    try {
      await api(base, { method: "POST", body: { action: f.get("action"), host: f.get("host"), path: f.get("path") || undefined } });
      e.target.reset(); reloadNetRules();
    } catch (err) { alert(err.message); }
  });
  const hf = el.querySelector("#net-header-add");
  ["op", "valueSource", "scope"].forEach((n) => hf[n].addEventListener("change", syncHeaderForm));
  hf.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const isSet = f.get("op") === "set";
    const useSecret = isSet && f.get("valueSource") === "secret";
    const base = f.get("scope") === "global" ? "/api/net/headers" : `/api/projects/${netId}/net/headers`;
    try {
      await api(base, {
        method: "POST",
        body: {
          direction: f.get("direction"), op: f.get("op"), host: f.get("host"), header: f.get("header"),
          value: isSet && !useSecret ? (f.get("value") || "") : undefined,
          valueSecretId: useSecret ? (f.get("valueSecretId") || undefined) : undefined,
        },
      });
      e.target.reset(); syncHeaderForm(); reloadNetRules();
    } catch (err) { alert(err.message); }
  });
  syncHeaderForm();
}

async function sendApproval(aid, action, duration) {
  try {
    await api(`/api/projects/${netId}/net/approvals/${aid}`, { method: "POST", body: { action, duration } });
    netModel.pending = netModel.pending.filter((p) => p.id !== aid);
    renderPending();
  } catch (err) { alert(err.message); }
}

const fmtClock = (ts) => new Date(ts).toTimeString().slice(0, 8);

// sign out (the link only shows when sign-in is enabled)
fetch("/api/auth/status").then((r) => r.json()).then((s) => { $("#nav-signout").hidden = !s.enabled; }).catch(() => {});
$("#nav-signout").onclick = async (e) => {
  e.preventDefault();
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
};

// boot: secrets cache first (for create-form checkboxes), then route
refreshVault().catch(() => {}).then(() => { if (!location.hash) location.hash = "home"; else route(); });
setInterval(() => { if (!$("#view-projects").hidden) { refreshProjects(); refreshNavTree(); } }, 5000);
setInterval(() => { if (!$("#view-home").hidden) refreshServiceStatus(); }, 5000);
