const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
};

let secretsCache = [];

// ---- side nav routing ----
// hashes: #projects (list) · #secrets · #project/<id> (detail)
let detailTimer = null;
function route() {
  const hash = location.hash.slice(1);
  const [head, arg] = hash.split("/");
  clearInterval(detailTimer); detailTimer = null;
  if (!(head === "project" && arg)) closeNet();

  const detail = head === "project" && arg;
  const isProjects = !["secrets", "settings"].includes(head) && !detail;
  $("#view-projects").hidden = !isProjects;
  $("#view-secrets").hidden = head !== "secrets";
  $("#view-settings").hidden = head !== "settings";
  $("#view-detail").hidden = !detail;

  const activeNav = head === "secrets" ? "secrets" : head === "settings" ? "settings" : "projects";
  document.querySelectorAll(".nav-item").forEach((a) =>
    a.classList.toggle("active", a.dataset.view === activeNav));

  if (head === "secrets") refreshSecrets();
  else if (head === "settings") loadSettings();
  else if (detail) openDetail(arg);
  else { closeCreateForm(); refreshProjects(); }
  refreshNavTree();
}
addEventListener("hashchange", route);
const showView = (v) => { location.hash = v; };

// ---- nested project list in the sidebar ----
async function refreshNavTree() {
  const [projects, pending] = await Promise.all([
    api("/api/projects").catch(() => []),
    api("/api/net/pending").catch(() => ({})),
  ]);
  const cur = location.hash.slice(1).split("/");
  const activeId = cur[0] === "project" ? cur[1] : null;
  $("#nav-projects").innerHTML = projects.map((p) => {
    const state = p.live?.state === "running" ? "running" : p.state;
    const n = pending[p.id] || 0;
    const badge = n ? `<span class="nav-badge" title="${n} request(s) awaiting approval">${n}</span>` : "";
    return `<li><a href="#project/${p.id}" class="nav-sub ${p.id === activeId ? "active" : ""}">
      <span class="dot ${state}"></span>${p.name}${badge}</a></li>`;
  }).join("");
}

// ---- secrets (global) ----
async function refreshSecrets() {
  secretsCache = await api("/api/secrets");
  $("#secrets").innerHTML = secretsCache.length
    ? secretsCache.map((s) =>
        `<li><span>${s.name}</span>
         <button class="danger" data-del-secret="${s.id}">delete</button></li>`).join("")
    : `<li class="empty">No secrets yet.</li>`;
  $("#create-secrets").innerHTML = secretsCache.length
    ? secretsCache.map((s) =>
        `<label><input type="checkbox" name="secret" value="${s.id}">${s.name}</label>`).join("")
    : `<span class="empty">none defined</span>`;
}

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
    const state = p.live?.state === "running" ? "running" : p.state;
    const gitLine = p.git_remote
      ? `<br>remote ${escapeHtml(p.git_remote)}${p.has_git_token ? " 🔑" : ""}`
      : "";
    return `
    <div class="card" data-id="${p.id}">
      <h3><a href="#project/${p.id}"><span class="dot ${state}"></span>${p.name}</a></h3>
      <div class="meta">
        ${state} · ${p.image}${p.live?.address ? ` · ${p.live.address}` : ""}<br>
        ${escapeHtml(p.source_path)}<br>
        branch sadbox/${p.name}${gitLine}${p.error ? `<br><span style="color:var(--bad)">${escapeHtml(p.error)}</span>` : ""}
      </div>
      <div class="row">
        <button data-details="${p.id}">Details</button>
        <button data-term="${p.id}" data-name="${p.name}">Terminal ↗</button>
        <button data-sync="${p.id}">Sync back</button>
        <button data-secrets="${p.id}" data-name="${p.name}">Secrets…</button>
        <button class="danger" data-destroy="${p.id}" data-name="${p.name}">Destroy</button>
      </div>
      <div class="sync-result"></div>
    </div>`;
  }).join("");
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.dataset.term) {
      window.open(`/terminal?id=${b.dataset.term}&name=${b.dataset.name}`, "_blank");
    } else if (b.dataset.details) {
      location.hash = `project/${b.dataset.details}`;
    } else if (b.dataset.sync) {
      b.disabled = true; b.textContent = "Syncing…";
      const r = await api(`/api/projects/${b.dataset.sync}/sync`, { method: "POST", body: {} });
      const out = r.upToDate
        ? "Already up to date."
        : `Fetched into ${r.ref} (${r.bundleBytes} bytes)\n\n${r.commits}\n\n${r.diffstat}\n\nApply with e.g.:\n  git merge ${r.ref}`;
      const container = b.closest(".card") || $("#view-detail");
      container.querySelector(".sync-result").innerHTML =
        `<pre class="result">${escapeHtml(out)}</pre>`;
      b.disabled = false; b.textContent = "Sync back";
    } else if (b.dataset.secrets) {
      openProjectSecrets(b.dataset.secrets, b.dataset.name || b.closest(".card")?.querySelector("h3").textContent.trim() || "project");
    } else if (b.dataset.destroy) {
      if (confirm(`Destroy project "${b.dataset.name}"? The VM and any unsynced work in it are deleted.`)) {
        await api(`/api/projects/${b.dataset.destroy}`, { method: "DELETE" });
        if (location.hash.startsWith("#project/")) location.hash = "projects";
        else { refreshProjects(); refreshNavTree(); }
      }
    } else if (b.dataset.delSecret) {
      if (confirm("Delete this secret?")) {
        await api(`/api/secrets/${b.dataset.delSecret}`, { method: "DELETE" });
        refreshSecrets();
      }
    }
  } catch (err) {
    alert(err.message);
    refreshProjects();
  }
});

// ---- project secrets dialog ----
const psec = $("#psec");
let psecProjectId = null;

async function renderProjectSecrets() {
  const view = await api(`/api/projects/${psecProjectId}/secrets`);
  $("#psec-own").innerHTML = view.own.length
    ? view.own.map((s) =>
        `<li><span>${s.name}</span>
         <button class="danger" data-del-secret="${s.id}">delete</button></li>`).join("")
    : `<li class="empty">none — add one below</li>`;
  const assigned = new Set(view.assigned.map((s) => s.id));
  $("#psec-globals").innerHTML = secretsCache.length
    ? secretsCache.map((s) =>
        `<label><input type="checkbox" name="psec-g" value="${s.id}"
          ${assigned.has(s.id) ? "checked" : ""}>${s.name}</label>`).join("")
    : `<span class="empty">no global secrets defined</span>`;
  $("#psec-status").textContent = "";
}

async function openProjectSecrets(id, name) {
  psecProjectId = id;
  $("#psec-title").textContent = `Secrets — ${name}`;
  if (!secretsCache.length) await refreshSecrets();
  psec.showModal();
  await renderProjectSecrets();
}

$("#psec-close").onclick = () => psec.close();
$("#psec-add").onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api(`/api/projects/${psecProjectId}/secrets`, {
      method: "POST",
      body: { name: f.get("name"), value: f.get("value") },
    });
    e.target.reset();
    await renderProjectSecrets();
    $("#psec-status").textContent = "project secret added & injected";
  } catch (err) { $("#psec-status").textContent = err.message; }
};
$("#psec-own").onclick = async (e) => {
  const b = e.target.closest("button[data-del-secret]");
  if (!b) return;
  if (!confirm("Delete this project-specific secret?")) return;
  try {
    await api(`/api/secrets/${b.dataset.delSecret}`, { method: "DELETE" });
    await renderProjectSecrets();
  } catch (err) { $("#psec-status").textContent = err.message; }
};
$("#psec-apply").onclick = async () => {
  const ids = [...psec.querySelectorAll("input[name=psec-g]:checked")].map((c) => c.value);
  try {
    await api(`/api/projects/${psecProjectId}/secrets`, { method: "PUT", body: { secretIds: ids } });
    $("#psec-status").textContent = "globals updated & injected";
  } catch (err) { $("#psec-status").textContent = err.message; }
};

// ---- folder picker ----
const picker = $("#picker");
let pickerPath = null;

async function loadDir(path) {
  const q = path ? `?path=${encodeURIComponent(path)}` : "";
  const d = await api(`/api/fs/dirs${q}`);
  pickerPath = d.path;
  $("#picker-current").textContent = d.path;
  $("#picker-hint").textContent = d.isGitRepo ? "✓ git repository" : "not a git repo (projects need one)";
  $("#picker-hint").style.color = d.isGitRepo ? "var(--ok)" : "var(--warn)";
  const items = [];
  if (d.parent) items.push(`<li data-dir="${d.parent}" class="up">↩ ..</li>`);
  items.push(...d.dirs.map((e) =>
    `<li data-dir="${d.path === "/" ? "" : d.path}/${e.name}">
       📁 ${e.name}${e.isGitRepo ? ` <span class="git-badge">git</span>` : ""}</li>`));
  $("#picker-list").innerHTML = items.join("") || `<li class="empty">no subfolders</li>`;
}

$("#btn-browse").onclick = () => {
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
  if (pickerPath) $("#create-form").sourcePath.value = pickerPath;
  picker.close();
};

// ---- create project ---- (form replaces the grid while open)
function openCreateForm() {
  $("#create-form").hidden = false;
  $("#projects").hidden = true;
  $("#btn-new").hidden = true;
}
function closeCreateForm() {
  $("#create-form").hidden = true;
  $("#projects").hidden = false;
  $("#btn-new").hidden = false;
}
$("#btn-new").onclick = openCreateForm;
$("#btn-cancel").onclick = closeCreateForm;
$("#git-toggle").onchange = (e) => { $("#git-fields").hidden = !e.target.checked; };

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
  const f = new FormData(e.target);
  const status = $("#create-status");
  status.textContent = "Creating (boot + copy-in, a few seconds)…";
  try {
    const git = f.get("gitEnabled") && f.get("gitRemote")
      ? { remote: f.get("gitRemote").trim(), token: (f.get("gitToken") || "").trim() || undefined }
      : undefined;
    await api("/api/projects", {
      method: "POST",
      body: {
        name: f.get("name"),
        sourcePath: f.get("sourcePath"),
        apps: (f.get("apps") || "").split(",").map((s) => s.trim()).filter(Boolean),
        secretIds: [...e.target.querySelectorAll("input[name=secret]:checked")].map((c) => c.value),
        git,
      },
    });
    status.textContent = "";
    e.target.reset();
    $("#git-fields").hidden = true;
    closeCreateForm();
    refreshProjects();
    refreshNavTree();
  } catch (err) {
    status.textContent = err.message;
  }
};

$("#secret-form").onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api("/api/secrets", { method: "POST", body: { name: f.get("name"), value: f.get("value") } });
    e.target.reset();
    refreshSecrets();
  } catch (err) {
    alert(err.message);
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
function showDetailSkeleton() {
  $("#detail-name").innerHTML = `<span class="sk sk-line" style="width:90px;display:inline-block"></span>`;
  $("#detail-actions").innerHTML = Array.from({ length: 4 }, () =>
    `<span class="sk sk-btn"></span>`).join("");
  // #detail-stats is refreshed on a timer; #detail-net is a persistent panel fed
  // live by SSE — keep them separate so the poll never wipes the network view.
  $("#detail-body").innerHTML =
    `<div id="detail-stats">
       <div class="loading-bar"><span class="spinner"></span> Loading VM details…</div>
       <div class="detail-grid">${skeletonPanel(6) + skeletonPanel(6) + skeletonPanel(6)}</div>
     </div>
     <div id="detail-net"></div>
     <div class="sync-result"></div>`;
}

async function openDetail(id) {
  showDetailSkeleton();
  openNet(id);
  await renderDetail(id);
  clearInterval(detailTimer);
  detailTimer = setInterval(() => {
    if (location.hash === `#project/${id}`) renderDetail(id); else clearInterval(detailTimer);
  }, 4000);
}

async function renderDetail(id) {
  let d;
  const stats = $("#detail-stats") || $("#detail-body");
  try { d = await api(`/api/projects/${id}/details`); }
  catch (e) { stats.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }
  $("#detail-name").textContent = d.name;
  const state = d.live?.state === "running" ? "running" : d.state;
  const r = d.resources;
  const term = d.tmux.clients > 0
    ? `<span class="ok">● ${d.tmux.clients} attached</span>`
    : `<span class="dim">none attached</span>`;

  $("#detail-actions").innerHTML = `
    <button data-term="${d.id}" data-name="${d.name}">Terminal ↗</button>
    <button data-sync="${d.id}">Sync back</button>
    <button data-secrets="${d.id}">Secrets…</button>
    <button class="danger" data-destroy="${d.id}" data-name="${d.name}">Destroy</button>`;

  stats.innerHTML = `
    <div class="detail-grid">
      <div class="panel stat">
        <h3>Status</h3>
        <dl>
          <dt>State</dt><dd><span class="dot ${state}"></span>${state}</dd>
          <dt>IP address</dt><dd>${d.live?.address || "—"}</dd>
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
          <dt>Memory</dt><dd class="metered">${fmtBytes(r.memoryUsageBytes)} / ${fmtBytes(r.memoryLimitBytes)} ${bar(r.memoryUsageBytes, r.memoryLimitBytes)}</dd>
          <dt>Disk</dt><dd class="metered">${fmtBytes(r.diskUsedBytes)} / ${fmtBytes(r.diskTotalBytes)} ${bar(r.diskUsedBytes, r.diskTotalBytes)}</dd>
          <dt>Workdir size</dt><dd>${fmtBytes(r.workdirBytes)}</dd>
          <dt>Processes</dt><dd>${r.numProcesses ?? "—"}</dd>
          <dt>Network</dt><dd>↓ ${fmtBytes(r.networkRxBytes)} · ↑ ${fmtBytes(r.networkTxBytes)}</dd>
        </dl>
      </div>

      <div class="panel stat">
        <h3>Folder & git</h3>
        <dl>
          <dt>Source folder</dt><dd class="mono">${escapeHtml(d.source_path)}</dd>
          <dt>Workdir (in VM)</dt><dd class="mono">${escapeHtml(d.workdir)}</dd>
          <dt>Work branch</dt><dd class="mono">${escapeHtml(d.branch)}</dd>
          <dt>Uncommitted</dt><dd>${d.git.dirty ?? 0} file(s)</dd>
          <dt>Git remote</dt><dd class="mono">${d.git_remote ? escapeHtml(d.git_remote) + (d.has_git_token ? " 🔑" : "") : "—"}</dd>
          <dt>Apps</dt><dd>${d.apps.length ? d.apps.map(escapeHtml).join(", ") : "base image only"}</dd>
        </dl>
      </div>
    </div>
    ${d.error ? `<div class="panel" style="color:var(--bad)">${escapeHtml(d.error)}</div>` : ""}`;
}

// ---- network activity panel (per-project egress proxy) ----
let netES = null;
let netId = null;
let netModel = { requests: [], pending: [], rules: [], headerRules: [] };
let netOwnSecrets = []; // this project's own secrets (for header-value picker)
const DUR_OPTS = [["once", "once"], ["1m", "1 min"], ["5m", "5 min"], ["30m", "30 min"], ["60m", "60 min"], ["forever", "forever"]];

function openNet(id) {
  closeNet();
  netId = id;
  netModel = { requests: [], pending: [], rules: [], headerRules: [] };
  netOwnSecrets = [];
  const el = $("#detail-net");
  if (!el) return;
  el.innerHTML = netShellHtml();
  bindNetHandlers(el);
  renderPending(); renderLog(); renderRules(); renderHeaders();
  connectNetStream(id);
  // secrets available as header values: globals (secretsCache) + this project's own
  Promise.all([
    secretsCache.length ? Promise.resolve() : refreshSecrets(),
    api(`/api/projects/${id}/secrets`).then((v) => { netOwnSecrets = v.own || []; }).catch(() => {}),
  ]).then(() => { if (netId === id) syncHeaderForm(); });
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

function headerSecretOptions(scope) {
  const g = (secretsCache || []).map((s) => `<option value="${s.id}">${escapeHtml(s.name)} · global</option>`).join("");
  const p = scope === "project"
    ? (netOwnSecrets || []).map((s) => `<option value="${s.id}">${escapeHtml(s.name)} · project</option>`).join("")
    : "";
  return `<option value="">— pick a secret —</option>${g}${p}`;
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
      renderPending(); renderLog(); renderRules(); renderHeaders();
    } else if (ev.type === "request") {
      netModel.requests.push(ev.entry);
      if (netModel.requests.length > 500) netModel.requests.shift();
      renderLog();
    } else if (ev.type === "pending") {
      if (!netModel.pending.some((p) => p.id === ev.pending.id)) netModel.pending.push(ev.pending);
      renderPending(); refreshNavTree();
    } else if (ev.type === "pending-resolved") {
      netModel.pending = netModel.pending.filter((p) => p.id !== ev.id);
      renderPending(); refreshNavTree();
      reloadNetRules(); // a timed/forever answer may have created a rule
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
    renderRules(); renderHeaders();
  } catch {}
}

function netShellHtml() {
  return `
  <div class="panel net-panel">
    <div class="net-head">
      <h3>Network</h3>
      <span id="net-status" class="net-live">connecting…</span>
      <span class="grow"></span>
      <a class="net-ca" href="/api/net/ca" download title="Trust this CA to inspect traffic outside a VM">Download CA</a>
    </div>
    <div id="net-pending"></div>
    <div class="net-section">
      <div class="net-subhead">Rules <span class="hint">block wins · no match ⇒ ask for approval</span></div>
      <div id="net-rules"></div>
      <form id="net-rule-add" class="net-form">
        <select name="action"><option value="allow">allow</option><option value="block">block</option></select>
        <input name="host" placeholder="host — api.github.com, *.github.com, *" required>
        <input name="path" placeholder="path glob (optional)">
        <select name="scope"><option value="project">this project</option><option value="global">all projects</option></select>
        <button class="primary" type="submit">Add</button>
      </form>
    </div>
    <details class="net-section">
      <summary class="net-subhead">Header rules</summary>
      <div id="net-headers"></div>
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
    </details>
    <div class="net-section">
      <div class="net-subhead">Live requests</div>
      <div class="net-log-wrap">
        <table class="net-log">
          <thead><tr><th>time</th><th>method</th><th>host / path</th><th>status</th><th>decision</th><th>size</th></tr></thead>
          <tbody id="net-log"></tbody>
        </table>
      </div>
    </div>
  </div>`;
}

function renderPending() {
  const el = $("#net-pending");
  if (!el) return;
  if (!netModel.pending.length) { el.innerHTML = ""; return; }
  el.innerHTML = netModel.pending.map((p) => {
    const opts = DUR_OPTS.map(([v, l]) => `<option value="${v}"${v === "forever" ? " selected" : ""}>${l}</option>`).join("");
    return `<div class="approval" data-aid="${p.id}">
      <div class="approval-req">
        <span class="badge">${p.scheme}</span>
        <b>${escapeHtml(p.method)}</b>
        <span class="host">${escapeHtml(p.host)}</span><span class="path">${escapeHtml(p.path)}</span>
      </div>
      <div class="approval-actions">
        <select class="dur">${opts}</select>
        <button class="primary" data-approve>Allow</button>
        <button class="danger" data-block>Block</button>
      </div>
    </div>`;
  }).join("");
}

function renderLog() {
  const el = $("#net-log");
  if (!el) return;
  const rows = netModel.requests.slice(-200).reverse();
  if (!rows.length) { el.innerHTML = `<tr><td colspan="6" class="empty">no requests yet</td></tr>`; return; }
  el.innerHTML = rows.map((r) => {
    const s = r.status;
    const sc = s == null ? "" : s >= 500 ? "s5xx" : s >= 400 ? "s4xx" : s >= 300 ? "s3xx" : "s2xx";
    return `<tr class="dec-${r.decision}">
      <td class="mono">${fmtClock(r.ts)}</td>
      <td>${escapeHtml(r.method)}</td>
      <td class="np"><span class="host">${escapeHtml(r.host)}</span><span class="path">${escapeHtml(r.path)}</span></td>
      <td class="mono ${sc}">${s ?? "—"}</td>
      <td><span class="decb ${r.decision}">${r.decision}</span></td>
      <td class="mono">${fmtBytes(r.respBytes)}</td>
    </tr>`;
  }).join("");
}

function renderRules() {
  const el = $("#net-rules");
  if (!el) return;
  if (!netModel.rules.length) { el.innerHTML = `<div class="empty">no rules — every new host prompts for approval</div>`; return; }
  el.innerHTML = netModel.rules.map((r) => {
    const exp = r.expires_at ? ` <span class="hint">until ${fmtClock(Date.parse(r.expires_at))}</span>` : "";
    const parts = [r.host];
    if (r.path) parts.push("path:" + r.path);
    if (r.method) parts.push(r.method);
    return `<div class="rule">
      <span class="ract ${r.action}">${r.action}</span>
      <span class="rscope">${r.scope === "global" ? "global" : "project"}</span>
      <span class="rspec">${escapeHtml(parts.join(" · "))}${exp}</span>
      <button class="link-del" data-del-rule="${r.id}" title="delete">✕</button>
    </div>`;
  }).join("");
}

function renderHeaders() {
  const el = $("#net-headers");
  if (!el) return;
  if (!netModel.headerRules.length) { el.innerHTML = `<div class="empty">no header rules</div>`; return; }
  el.innerHTML = netModel.headerRules.map((r) => {
    let spec;
    if (r.op !== "set") spec = `remove ${escapeHtml(r.header)}`;
    else if (r.value_secret_id) spec = `${escapeHtml(r.header)} ← <span class="secref">🔑 ${escapeHtml(r.value_secret_name || "secret")}</span>`;
    else spec = `${escapeHtml(r.header)}: ${escapeHtml(r.value || "")}`;
    return `<div class="rule">
      <span class="ract ${r.direction === "request" ? "allow" : "block"}">${r.direction}</span>
      <span class="rscope">${r.scope === "global" ? "global" : "project"}</span>
      <span class="rspec">${escapeHtml(r.host)} · ${spec}</span>
      <button class="link-del" data-del-header="${r.id}" title="delete">✕</button>
    </div>`;
  }).join("");
}

function bindNetHandlers(el) {
  el.addEventListener("click", async (e) => {
    const appr = e.target.closest(".approval");
    if (appr && e.target.closest("[data-approve]")) {
      return sendApproval(appr.dataset.aid, "allow", appr.querySelector(".dur").value);
    }
    if (appr && e.target.closest("[data-block]")) {
      const d = appr.querySelector(".dur").value; // once ⇒ deny this only; else a permanent block rule
      return sendApproval(appr.dataset.aid, "block", d === "once" ? "once" : "forever");
    }
    const dr = e.target.closest("[data-del-rule]");
    if (dr) { try { await api(`/api/net/rules/${dr.dataset.delRule}`, { method: "DELETE" }); } catch {} return reloadNetRules(); }
    const dh = e.target.closest("[data-del-header]");
    if (dh) { try { await api(`/api/net/headers/${dh.dataset.delHeader}`, { method: "DELETE" }); } catch {} return reloadNetRules(); }
  });
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

// boot: secrets cache first (for create-form checkboxes), then route
refreshSecrets().then(() => { if (!location.hash) location.hash = "projects"; else route(); });
setInterval(() => { if (!$("#view-projects").hidden) { refreshProjects(); refreshNavTree(); } }, 5000);
