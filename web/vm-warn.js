// A warning strip for the terminal and editor tabs: when the VM is above 80%
// CPU or memory, say so — with links to where the allocation is changed — so
// the user can act before the agent grinds to a halt.
//
//   sadboxVmWarn({ projectId, name })
//
// Polls the project's details (which the main UI uses too); the terminal keeps
// working underneath. Dismissing hides it for ten minutes, and it comes back
// early if usage first drops below the threshold and rises again.
(function () {
  const CSS = `
  #vm-warn { position: fixed; top: 52px; left: 50%; transform: translateX(-50%); z-index: 30;
    width: min(760px, calc(100vw - 24px)); display: none; align-items: center; gap: 10px;
    background: #2a1d0b; color: #f0dfc0; border: 1px solid #6b4a12; border-radius: 10px;
    padding: 9px 12px; font: 13px system-ui; box-shadow: 0 8px 28px #000a; }
  #vm-warn.show { display: flex; }
  #vm-warn .what { flex: 1; min-width: 0; }
  #vm-warn b { color: #f5b544; }
  #vm-warn a { color: #9fc0ff; }
  #vm-warn .close { background: none; border: 0; color: #f5b544; cursor: pointer; font-size: 18px;
    line-height: 1; padding: 0 2px; }
  `;
  const HOT = 80;

  window.sadboxVmWarn = function ({ projectId }) {
    if (!projectId) return;
    document.head.appendChild(Object.assign(document.createElement("style"), { textContent: CSS }));
    const el = document.body.appendChild(Object.assign(document.createElement("div"), { id: "vm-warn" }));
    const dismissKey = `sadbox-vm-warn:${projectId}`;
    const DISMISS_MS = 10 * 60_000;
    let busy = false;

    const dismiss = () => {
      sessionStorage.setItem(dismissKey, String(Date.now() + DISMISS_MS));
      el.classList.remove("show");
    };

    function show(cpu, mem, usedGB, limitGB) {
      const parts = [];
      if (cpu != null) parts.push(`CPU <b>${Math.round(cpu)}%</b>`);
      if (mem != null) {
        const of = usedGB != null && limitGB != null ? ` (${usedGB.toFixed(1)} of ${limitGB.toFixed(1)} GB)` : "";
        parts.push(`memory <b>${Math.round(mem)}%</b>${of}`);
      }
      el.innerHTML = `<span>⚠</span>
        <div class="what">This VM is working hard — ${parts.join(" · ")}.
          Change memory on its <a href="/#project/${encodeURIComponent(projectId)}" target="_blank" rel="noopener">project page</a>;
          CPU is set under <a href="/#settings" target="_blank" rel="noopener">Settings</a> and applies on a rebuild.</div>
        <button class="close" type="button" title="Dismiss for 10 minutes">×</button>`;
      el.querySelector(".close").onclick = dismiss;
      el.classList.add("show");
    }

    async function check() {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/details`, {
          headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000),
        });
        if (!r.ok) { el.classList.remove("show"); return; }
        const d = await r.json();
        if (d.state !== "running") { el.classList.remove("show"); return; }
        const res = d.resources || {};
        const mem = res.memoryLimitBytes ? (res.memoryUsageBytes / res.memoryLimitBytes) * 100 : null;
        const cpu = typeof res.cpuPercent === "number" ? res.cpuPercent : null;
        const hot = (cpu != null && cpu > HOT) || (mem != null && mem > HOT);
        if (!hot) {
          // below the line again: a later spike warns afresh even after a dismissal
          sessionStorage.removeItem(dismissKey);
          el.classList.remove("show");
          return;
        }
        if (Date.now() < Number(sessionStorage.getItem(dismissKey) || 0)) return;
        show(cpu, mem, res.memoryUsageBytes != null ? res.memoryUsageBytes / 1024 ** 3 : null,
          res.memoryLimitBytes != null ? res.memoryLimitBytes / 1024 ** 3 : null);
      } catch {
        el.classList.remove("show"); // the VM is down, or the page is gone
      } finally {
        busy = false;
      }
    }

    setInterval(check, 15_000);
    setTimeout(check, 4_000);
    addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
  };
})();
