// Network approval popups, shared by the terminal and editor tabs.
//
// When something in a VM asks for a host no rule covers, the proxy holds the
// request and waits for an answer. This shows the held request on whichever
// page the user is working in — with the method, URL and a countdown — and
// lets them allow it (once, for a while, or always) or deny it, instead of
// making them go and find the project page.
//
//   sadboxNetAsks({ projectId, notify(message, isWarning), onAnswered() })
(function () {
  const CSS = `
  #asks { position: fixed; top: 46px; right: 14px; z-index: 20; display: flex; flex-direction: column; gap: 10px;
          width: min(430px, calc(100vw - 28px)); max-height: calc(100vh - 60px); overflow-y: auto; font: 13px system-ui; }
  .ask { background: #14141c; color: #e6e6ef; border: 1px solid #f5b544; border-radius: 10px; padding: 12px 14px;
         box-shadow: 0 10px 34px #000c; animation: ask-in .16s ease; }
  @keyframes ask-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
  .ask-head { display: flex; align-items: center; gap: 8px; color: #f5b544; font-weight: 600; margin-bottom: 8px; }
  .ask-head .left { margin-left: auto; color: #8a8aa0; font-weight: 400; font-size: 12px; font-variant-numeric: tabular-nums; }
  .ask-host { font: 600 14px ui-monospace, "SF Mono", Menlo, monospace; word-break: break-all; }
  .ask-req { margin-top: 3px; color: #8a8aa0; font: 12px ui-monospace, "SF Mono", Menlo, monospace; word-break: break-all;
             display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .ask-req b { color: #cbd5e1; font-weight: 600; }
  .ask-note { margin-top: 6px; color: #8a8aa0; font-size: 12px; }
  .ask-note b { color: #f5b544; }
  .ask-row { display: flex; align-items: center; gap: 6px; margin-top: 11px; flex-wrap: wrap; }
  .ask-row label { color: #8a8aa0; font-size: 12px; }
  .ask button { font: inherit; font-size: 12px; border-radius: 7px; padding: 5px 10px; cursor: pointer; }
  .ask .durbtn { background: #182238; color: #cbd5e1; border: 1px solid #2f4a7a; }
  .ask .durbtn:hover { border-color: #5b8cff; }
  .ask .deny { background: #1a1a24; color: #ffb4b4; border: 1px solid #5a2a2e; }
  .ask .always { margin-left: auto; background: none; border: 0; color: #8a8aa0; text-decoration: underline; padding: 5px 2px; }
  .ask button:hover { filter: brightness(1.15); } .ask button:disabled { opacity: .5; cursor: default; }
  `;
  // Clicking a duration IS the answer; there is no separate Allow button.
  const DURATIONS = [["once", "once"], ["1m", "1m"], ["5m", "5m"], ["30m", "30m"], ["60m", "1h"], ["forever", "always"]];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  window.sadboxNetAsks = function ({ projectId, notify = () => {}, onAnswered = () => {} }) {
    document.head.appendChild(Object.assign(document.createElement("style"), { textContent: CSS }));
    const box = document.body.appendChild(Object.assign(document.createElement("div"), { id: "asks" }));
    const asks = new Map();     // approval id -> pending request, as sent by the proxy
    const answered = new Set(); // ids answered from this tab (no "answered elsewhere" notice)

    function render() {
      box.innerHTML = [...asks.values()].map((p) => {
        const plain = p.scheme === "https" ? "" : " (not encrypted)";
        // "always" is omitted for a credential: it would bind the secret to the host for good
        const opts = DURATIONS.filter(([v]) => !(p.credential && v === "forever"))
          .map(([v, l]) => `<button class="durbtn" data-act="allow" data-duration="${v}" title="Allow ${v === "once" ? "just this request" : "for " + l}">${l}</button>`).join("");
        // a credential ask: the request carries a proxy secret's placeholder to a host it isn't bound to
        const head = p.credential ? `🔑 Secret requested` : `⚠ Network request blocked`;
        const note = p.credential
          ? `A program in the VM wants to send <b>${esc(p.credential.name)}</b> to this host. Allowing binds the secret to it for that long.`
          : `A program in the VM is waiting. Allowing covers every request from this project to this host.`;
        const always = p.credential ? ""
          : `<button class="always" data-act="block" title="Add a permanent block rule for this host">always block</button>`;
        return `<div class="ask" data-id="${p.id}">
          <div class="ask-head">${head} <span class="left" data-left></span></div>
          <div class="ask-host">${esc(p.host)}</div>
          <div class="ask-req"><b>${esc(p.method)}</b> ${esc(p.scheme)}://${esc(p.host)}${esc(p.path)}${plain}</div>
          <div class="ask-note">${note}</div>
          <div class="ask-row">
            <label>Allow for</label>${opts}
            <button class="deny" data-act="deny">Deny</button>
            ${always}
          </div>
        </div>`;
      }).join("");
      tick();
    }

    function tick() {
      for (const el of box.querySelectorAll(".ask")) {
        const p = asks.get(el.dataset.id);
        if (!p) continue;
        const s = Math.max(0, Math.ceil((p.expiresAt - Date.now()) / 1000));
        el.querySelector("[data-left]").textContent = p.expiresAt ? `denied in ${s}s` : "";
      }
    }
    setInterval(tick, 1000);

    box.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const card = btn.closest(".ask"), id = card.dataset.id, p = asks.get(id);
      const act = btn.dataset.act;
      // deny = this request only; "always block" writes a permanent block rule
      const body = act === "allow" ? { action: "allow", duration: btn.dataset.duration }
                 : act === "block" ? { action: "block", duration: "forever" }
                 : { action: "block", duration: "once" };
      for (const b of card.querySelectorAll("button")) b.disabled = true;
      try {
        const r = await fetch(`/api/projects/${projectId}/net/approvals/${id}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
        answered.add(id); asks.delete(id); render();
        notify(act === "allow" ? `Allowed ${p.host}` : `Denied ${p.host}`, act !== "allow");
      } catch (err) {
        for (const b of card.querySelectorAll("button")) b.disabled = false;
        notify(`Could not answer: ${err.message}`, true);
      }
      onAnswered();
    });

    const es = new EventSource(`/api/projects/${projectId}/net/stream`);
    es.onmessage = (e) => {
      let ev; try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.type === "snapshot") {           // (re)connected: this is everything being held right now
        asks.clear();
        for (const p of ev.pending || []) asks.set(p.id, p);
        render();
      } else if (ev.type === "pending") {
        asks.set(ev.pending.id, ev.pending); render();
      } else if (ev.type === "pending-resolved") {
        if (answered.delete(ev.id)) return;   // answered here: already handled
        const p = asks.get(ev.id);
        if (!p) return;
        asks.delete(ev.id); render();
        // answered elsewhere (the project page, another tab) or nobody answered in time
        notify(ev.reason === "timeout" ? `No answer — ${p.host} was denied`
             : `${p.host} ${ev.action === "allow" ? "allowed" : "denied"} elsewhere`, ev.action !== "allow");
      }
    };
    // EventSource reconnects by itself; the next snapshot resyncs the popups
  };
})();
