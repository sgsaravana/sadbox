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

let secretsCache = [];

// ---- side nav routing ----
// hashes: #projects (list) · #secrets · #project/<id> (detail)
let detailTimer = null;
let openCreateNext = false; // set by the Home CTA so #projects opens the create form
function route() {
  const hash = location.hash.slice(1);
  const [head, arg] = hash.split("/");
  clearInterval(detailTimer); detailTimer = null;
  if (!(head === "project" && arg)) closeNet();

  const detail = head === "project" && arg;
  const isProjects = head === "projects";
  const isSecrets = head === "secrets";
  const isSettings = head === "settings";
  const isHome = !detail && !isProjects && !isSecrets && !isSettings; // default / #home / unknown

  $("#view-home").hidden = !isHome;
  $("#view-projects").hidden = !isProjects;
  $("#view-secrets").hidden = !isSecrets;
  $("#view-settings").hidden = !isSettings;
  $("#view-detail").hidden = !detail;

  const activeNav = isSecrets ? "secrets" : isSettings ? "settings"
    : (isProjects || detail) ? "projects" : "home";
  document.querySelectorAll(".nav-item").forEach((a) =>
    a.classList.toggle("active", a.dataset.view === activeNav));

  if (isSecrets) refreshSecrets();
  else if (isSettings) loadSettings();
  else if (detail) openDetail(arg);
  else if (isProjects) {
    refreshProjects();
    if (openCreateNext) { openCreateNext = false; openCreateForm(); } else closeCreateForm();
  }
  // isHome: static overview, nothing to load
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
    const state = p.state;
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
    const state = p.state;
    const gitLine = p.git_remote
      ? `<br>${p.source_path ? "remote" : "cloned from"} ${escapeHtml(p.git_remote)}${p.has_git_token ? " 🔑" : ""}`
      : "";
    return `
    <div class="card" data-id="${p.id}">
      <h3><a href="#project/${p.id}"><span class="dot ${state}"></span>${p.name}</a></h3>
      <div class="meta">
        ${state} · ${p.image}${p.live?.address ? ` · ${p.live.address}` : ""}<br>
        ${p.source_path ? escapeHtml(p.source_path) + "<br>" : ""}branch ${escapeHtml(p.branch || `sadbox/${p.name}`)}${gitLine}${p.error ? `<br><span style="color:var(--bad)">${escapeHtml(p.error)}</span>` : ""}
      </div>
      <div class="row">
        <button data-details="${p.id}">Details</button>
        ${powerButton(p)}
        <button data-term="${p.id}" data-name="${p.name}">${ICON.terminal}Terminal ↗</button>
        <button data-edit="${p.id}" data-name="${p.name}">${ICON.editor}Editor ↗</button>
        ${p.sync_folder ? `<button data-sync="${p.id}">${ICON.sync}Sync back</button>` : ""}
        <button data-secrets="${p.id}" data-name="${p.name}">${ICON.secrets}Secrets…</button>
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
    } else if (b.dataset.linkFolder) {
      // connect a local folder to a project cloned from a git URL (reuses the folder picker)
      const id = b.dataset.linkFolder;
      pickerOnSelect = (path) => { setSyncFolder(id, path); };
      picker.showModal();
      loadDir(b.dataset.current || null).catch(() => loadDir(null));
    } else if (b.dataset.unlinkFolder) {
      if (confirm("Disconnect this folder? Nothing in it is changed; the project just stops syncing there.")) {
        setSyncFolder(b.dataset.unlinkFolder, null);
      }
    } else if (b.dataset.secrets) {
      openProjectSecrets(b.dataset.secrets, b.dataset.name || b.closest(".card")?.querySelector("h3").textContent.trim() || "project");
    } else if (b.dataset.memory) {
      await changeMemory(b.dataset.memory, b.dataset.name, Number(b.dataset.mb) || null, b.dataset.running === "1");
    } else if (b.dataset.rebuild) {
      if (confirm(`Rebuild "${b.dataset.name}"? The VM is destroyed and recreated from the project's original source (local folder re-copied, or git remote re-cloned). Unsynced work inside the VM will be lost.`)) {
        b.disabled = true; b.textContent = "Rebuilding…";
        try {
          await api(`/api/projects/${b.dataset.rebuild}/rebuild`, { method: "POST", body: {} });
          if (location.hash.startsWith("#project/")) renderDetail(b.dataset.rebuild);
          else { refreshProjects(); refreshNavTree(); }
        } finally { b.disabled = false; b.textContent = "Rebuild"; }
      }
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

function openCreateForm() {
  $("#create-form").hidden = false;
  $("#projects").hidden = true;
  $("#btn-new").hidden = true;
  loadCreateToolchain();
  syncSrcMode();
}
function closeCreateForm() {
  $("#create-form").hidden = true;
  $("#projects").hidden = false;
  $("#btn-new").hidden = false;
}
$("#btn-new").onclick = openCreateForm;
$("#home-new").onclick = () => { openCreateNext = true; location.hash = "projects"; };
$("#btn-cancel").onclick = closeCreateForm;
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
  const f = new FormData(e.target);
  const status = $("#create-status");
  const mode = f.get("srcMode") || "local";
  let sourcePath, git;
  if (mode === "git") {
    // clone-in-VM mode: the git remote IS the source; no local folder
    git = { remote: (f.get("cloneRemote") || "").trim(), token: (f.get("cloneToken") || "").trim() || undefined };
    status.textContent = "Creating (boot + git clone, a few seconds)…";
  } else {
    sourcePath = (f.get("sourcePath") || "").trim();
    git = f.get("gitEnabled") && f.get("gitRemote")
      ? { remote: f.get("gitRemote").trim(), token: (f.get("gitToken") || "").trim() || undefined }
      : undefined;
    status.textContent = "Creating (boot + copy-in, a few seconds)…";
  }
  try {
    await api("/api/projects", {
      method: "POST",
      body: {
        name: f.get("name"),
        sourcePath, // undefined ⇒ backend clones the git remote instead
        apps: (f.get("apps") || "").split(",").map((s) => s.trim()).filter(Boolean),
        secretIds: [...e.target.querySelectorAll("input[name=secret]:checked")].map((c) => c.value),
        git,
      },
    });
    status.textContent = "";
    e.target.reset();
    $("#git-fields").hidden = true;
    syncSrcMode();
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
     <div id="detail-net">${skeletonNet()}</div>
     <div class="sync-result"></div>`;
}

async function openDetail(id) {
  showDetailSkeleton();
  openPorts(id);
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
    <button data-secrets="${d.id}">${ICON.secrets}Secrets…</button>
    ${powerButton(d)}
    <button data-rebuild="${d.id}" data-name="${d.name}" title="Destroy the VM and recreate it from the original source">${ICON.rebuild}Rebuild</button>
    <button class="danger" data-destroy="${d.id}" data-name="${d.name}">${ICON.destroy}Destroy</button>`;

  stats.innerHTML = `
    <div class="detail-grid">
      <div class="panel stat">
        <h3>Status</h3>
        <dl>
          <dt>State</dt><dd><span class="dot ${d.unresponsive ? "error" : state}"></span>${state}${d.unresponsive
            ? ` <span style="color:var(--bad)">· not responding</span> <span class="hint">Stop it, then Start — files are kept</span>` : ""}</dd>
          <dt>Network</dt><dd>${d.live?.isolated
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
          <dt>Source</dt><dd class="mono">${d.source_path ? escapeHtml(d.source_path) : "git clone"}</dd>
          ${d.source_path ? "" : `<dt>Local folder</dt><dd>${folderPending?.id === d.id
            ? `<span class="spinner"></span> <span class="dim">${folderPending.label}</span>`
            : d.sync_path
            ? `<span class="mono">${escapeHtml(d.sync_path)}</span>
               <button class="mini" data-link-folder="${d.id}" data-current="${escapeHtml(d.sync_path)}" title="Sync into a different folder">Change</button>
               <button class="mini" data-unlink-folder="${d.id}">Disconnect</button>`
            : `<span class="dim">not connected</span>
               <button class="mini" data-link-folder="${d.id}" title="Pick a local folder (a git repository or any other folder) to sync this project's work into">Connect a folder…</button>`}</dd>`}
          <dt>Workdir (in VM)</dt><dd class="mono">${escapeHtml(d.workdir)}</dd>
          <dt>Work branch</dt><dd class="mono">${escapeHtml(d.branch)}</dd>
          <dt>Uncommitted</dt><dd>${d.git.dirty ?? 0} file(s)</dd>
          <dt>Git remote</dt><dd class="mono">${d.git_remote ? escapeHtml(d.git_remote) + (d.has_git_token ? " 🔑" : "") : "—"}</dd>
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
        <button type="submit">Forward</button>
      </form>
    </div>
  </div>`;
  el.addEventListener("click", async (e) => {
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
        body: { guestPort: Number(f.get("guestPort")), hostPort: Number(f.get("hostPort")) },
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
    const url = `http://${location.hostname}:${f.host_port}`;
    return `<div class="rule">
      <span class="ract ${f.active ? "allow" : "block"}">${f.active ? "open" : "down"}</span>
      <span class="rspec"><a href="${url}" target="_blank" rel="noopener">${escapeHtml(location.hostname)}:${f.host_port}</a> → VM port ${f.guest_port}${
        f.active ? "" : ` <span class="hint">host port was in use at startup</span>`}</span>
      <button class="link-del" data-del-port="${f.id}" title="remove">✕</button>
    </div>`;
  }).join("");
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
    renderRules(); renderHeaders(); renderLog(); // log's "allowed" markers derive from rules
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
          <thead><tr><th>time</th><th>method</th><th>host / path</th><th>status</th><th>decision</th><th>size</th><th>allow host</th></tr></thead>
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
  if (!rows.length) { el.innerHTML = `<tr><td colspan="7" class="empty">no requests yet</td></tr>`; return; }
  // hosts already covered by a plain (host-only) allow rule, per scope — so we
  // can show "✓ allowed" instead of offering to add a duplicate rule
  const allowedProject = new Set(netModel.rules.filter((r) => r.action === "allow" && !r.path && !r.method && r.scope !== "global").map((r) => r.host));
  const allowedGlobal = new Set(netModel.rules.filter((r) => r.action === "allow" && !r.path && !r.method && r.scope === "global").map((r) => r.host));
  el.innerHTML = rows.map((r) => {
    const s = r.status;
    const sc = s == null ? "" : s >= 500 ? "s5xx" : s >= 400 ? "s4xx" : s >= 300 ? "s3xx" : "s2xx";
    const h = escapeHtml(r.host);
    const vmBtn = allowedProject.has(r.host)
      ? `<span class="rowallowed" title="already allowed for this VM">✓ VM</span>`
      : `<button class="rowallow" data-allow-host="${h}" data-scope="project" title="Allow ${h} for this VM">＋ VM</button>`;
    const glBtn = allowedGlobal.has(r.host)
      ? `<span class="rowallowed" title="already allowed for all VMs">✓ all</span>`
      : `<button class="rowallow" data-allow-host="${h}" data-scope="global" title="Allow ${h} for all VMs">＋ all</button>`;
    return `<tr class="dec-${r.decision}">
      <td class="mono">${fmtClock(r.ts)}</td>
      <td>${escapeHtml(r.method)}</td>
      <td class="np"><span class="host">${h}</span><span class="path">${escapeHtml(r.path)}</span></td>
      <td class="mono ${sc}">${s ?? "—"}</td>
      <td><span class="decb ${r.decision}">${r.decision}</span></td>
      <td class="mono">${fmtBytes(r.respBytes)}</td>
      <td class="rowact">${vmBtn}${glBtn}</td>
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
    const al = e.target.closest("[data-allow-host]");
    if (al) {
      const host = al.dataset.allowHost;
      const scope = al.dataset.scope; // "project" | "global"
      const base = scope === "global" ? "/api/net/rules" : `/api/projects/${netId}/net/rules`;
      al.disabled = true;
      try {
        await api(base, { method: "POST", body: { action: "allow", host } });
        al.textContent = "✓ done";
        await reloadNetRules(); // updates the Rules list and flips these buttons to "✓"
      } catch (err) { al.disabled = false; alert(err.message); }
      return;
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

// sign out (the link only shows when sign-in is enabled)
fetch("/api/auth/status").then((r) => r.json()).then((s) => { $("#nav-signout").hidden = !s.enabled; }).catch(() => {});
$("#nav-signout").onclick = async (e) => {
  e.preventDefault();
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
};

// boot: secrets cache first (for create-form checkboxes), then route
refreshSecrets().then(() => { if (!location.hash) location.hash = "home"; else route(); });
setInterval(() => { if (!$("#view-projects").hidden) { refreshProjects(); refreshNavTree(); } }, 5000);
