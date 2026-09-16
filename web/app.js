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
  const projects = await api("/api/projects").catch(() => []);
  const cur = location.hash.slice(1).split("/");
  const activeId = cur[0] === "project" ? cur[1] : null;
  $("#nav-projects").innerHTML = projects.map((p) => {
    const state = p.live?.state === "running" ? "running" : p.state;
    return `<li><a href="#project/${p.id}" class="nav-sub ${p.id === activeId ? "active" : ""}">
      <span class="dot ${state}"></span>${p.name}</a></li>`;
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
}
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
  $("#detail-body").innerHTML =
    `<div class="loading-bar"><span class="spinner"></span> Loading VM details…</div>
     <div class="detail-grid">${skeletonPanel(6) + skeletonPanel(6) + skeletonPanel(6)}</div>`;
}

async function openDetail(id) {
  showDetailSkeleton();
  await renderDetail(id);
  clearInterval(detailTimer);
  detailTimer = setInterval(() => {
    if (location.hash === `#project/${id}`) renderDetail(id); else clearInterval(detailTimer);
  }, 4000);
}

async function renderDetail(id) {
  let d;
  try { d = await api(`/api/projects/${id}/details`); }
  catch (e) { $("#detail-body").innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; return; }
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

  $("#detail-body").innerHTML = `
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
    ${d.error ? `<div class="panel" style="color:var(--bad)">${escapeHtml(d.error)}</div>` : ""}
    <div class="sync-result"></div>`;
}

// boot: secrets cache first (for create-form checkboxes), then route
refreshSecrets().then(() => { if (!location.hash) location.hash = "projects"; else route(); });
setInterval(() => { if (!$("#view-projects").hidden) { refreshProjects(); refreshNavTree(); } }, 5000);
