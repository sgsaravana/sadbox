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

async function refreshWorkers() {
  const workers = await api("/api/workers");
  const el = $("#workers");
  if (!workers.length) {
    el.innerHTML = `<div class="empty">No workers. Create one to get started.</div>`;
    return;
  }
  el.innerHTML = workers.map((w) => {
    const state = w.live?.state === "running" ? "running" : w.state;
    return `
    <div class="card" data-id="${w.id}">
      <h3><span class="dot ${state}"></span>${w.name}</h3>
      <div class="meta">
        ${state} · ${w.image}${w.live?.address ? ` · ${w.live.address}` : ""}<br>
        ${w.source_path}<br>
        branch sadbox/${w.name}${w.error ? `<br><span style="color:var(--bad)">${w.error}</span>` : ""}
      </div>
      <div class="row">
        <button data-term="${w.id}" data-name="${w.name}">Terminal ↗</button>
        <button data-sync="${w.id}">Sync back</button>
        <button data-secrets="${w.id}">Secrets…</button>
        <button class="danger" data-destroy="${w.id}" data-name="${w.name}">Destroy</button>
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
    } else if (b.dataset.sync) {
      b.disabled = true; b.textContent = "Syncing…";
      const r = await api(`/api/workers/${b.dataset.sync}/sync`, { method: "POST", body: {} });
      const out = r.upToDate
        ? "Already up to date."
        : `Fetched into ${r.ref} (${r.bundleBytes} bytes)\n\n${r.commits}\n\n${r.diffstat}\n\nApply with e.g.:\n  git merge ${r.ref}`;
      b.closest(".card").querySelector(".sync-result").innerHTML =
        `<pre class="result">${out.replace(/</g, "&lt;")}</pre>`;
      b.disabled = false; b.textContent = "Sync back";
    } else if (b.dataset.secrets) {
      openWorkerSecrets(b.dataset.secrets, b.closest(".card").querySelector("h3").textContent.trim());
    } else if (b.dataset.destroy) {
      if (confirm(`Destroy worker "${b.dataset.name}"? The VM and any unsynced work in it are deleted.`)) {
        await api(`/api/workers/${b.dataset.destroy}`, { method: "DELETE" });
        refreshWorkers();
      }
    } else if (b.dataset.delSecret) {
      if (confirm("Delete this secret?")) {
        await api(`/api/secrets/${b.dataset.delSecret}`, { method: "DELETE" });
        refreshSecrets();
      }
    }
  } catch (err) {
    alert(err.message);
    refreshWorkers();
  }
});

// ---- per-worker secrets dialog ----
const wsec = $("#wsec");
let wsecWorkerId = null;

async function renderWorkerSecrets() {
  const view = await api(`/api/workers/${wsecWorkerId}/secrets`);
  $("#wsec-own").innerHTML = view.own.length
    ? view.own.map((s) =>
        `<li><span>${s.name}</span>
         <button class="danger" data-wsec-del="${s.id}">delete</button></li>`).join("")
    : `<li class="empty">none — add one below</li>`;
  const assigned = new Set(view.assigned.map((s) => s.id));
  $("#wsec-globals").innerHTML = secretsCache.length
    ? secretsCache.map((s) =>
        `<label><input type="checkbox" name="wsec-g" value="${s.id}"
          ${assigned.has(s.id) ? "checked" : ""}>${s.name}</label>`).join("")
    : `<span class="empty">no global secrets defined</span>`;
  $("#wsec-status").textContent = "";
}

async function openWorkerSecrets(id, name) {
  wsecWorkerId = id;
  $("#wsec-title").textContent = `Secrets — ${name}`;
  wsec.showModal();
  await renderWorkerSecrets();
}

$("#wsec-close").onclick = () => wsec.close();
$("#wsec-add").onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api(`/api/workers/${wsecWorkerId}/secrets`, {
      method: "POST",
      body: { name: f.get("name"), value: f.get("value") },
    });
    e.target.reset();
    await renderWorkerSecrets();
    $("#wsec-status").textContent = "VM secret added & injected";
  } catch (err) { $("#wsec-status").textContent = err.message; }
};
$("#wsec-own").onclick = async (e) => {
  const b = e.target.closest("button[data-wsec-del]");
  if (!b) return;
  if (!confirm("Delete this VM-specific secret?")) return;
  try {
    await api(`/api/secrets/${b.dataset.wsecDel}`, { method: "DELETE" });
    await renderWorkerSecrets();
  } catch (err) { $("#wsec-status").textContent = err.message; }
};
$("#wsec-apply").onclick = async () => {
  const ids = [...wsec.querySelectorAll("input[name=wsec-g]:checked")].map((c) => c.value);
  try {
    await api(`/api/workers/${wsecWorkerId}/secrets`, { method: "PUT", body: { secretIds: ids } });
    $("#wsec-status").textContent = "globals updated & injected";
  } catch (err) { $("#wsec-status").textContent = err.message; }
};

// ---- folder picker ----
const picker = $("#picker");
let pickerPath = null;

async function loadDir(path) {
  const q = path ? `?path=${encodeURIComponent(path)}` : "";
  const d = await api(`/api/fs/dirs${q}`);
  pickerPath = d.path;
  $("#picker-current").textContent = d.path;
  $("#picker-hint").textContent = d.isGitRepo ? "✓ git repository" : "not a git repo (workers need one)";
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

$("#btn-new").onclick = () => { $("#create-panel").hidden = false; };
$("#btn-cancel").onclick = () => { $("#create-panel").hidden = true; };

$("#create-form").onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const status = $("#create-status");
  status.textContent = "Creating (boot + copy-in, a few seconds)…";
  try {
    await api("/api/workers", {
      method: "POST",
      body: {
        name: f.get("name"),
        sourcePath: f.get("sourcePath"),
        apps: (f.get("apps") || "").split(",").map((s) => s.trim()).filter(Boolean),
        secretIds: [...e.target.querySelectorAll("input[name=secret]:checked")].map((c) => c.value),
      },
    });
    status.textContent = "";
    e.target.reset();
    $("#create-panel").hidden = true;
    refreshWorkers();
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

refreshSecrets().then(refreshWorkers);
setInterval(refreshWorkers, 5000);
