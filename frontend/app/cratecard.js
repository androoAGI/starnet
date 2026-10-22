/* AGENT OS — cratecard.js : the CRATE INSPECT card (line watch, 2026-09-23).

   Click a crate riding a belt on the live floor (world.js crateAt → openCrate) and this small station card opens
   beside it: what job it carries, which line, where it came from and is going, the run working it (agent, live
   RECONCILED cost) or — once finished — the run's recorded outcome (GET /api/runs?runId=), plus two doors: the
   agent's LOGBOOK (where the run's transcript opens) and, for a step-test crate, the Workflow panel.

   TRUTH: the card never composes a field itself — LineWatch.crateCard() resolves every row from the crate's own
   payload, the bus-confirmed run record and the server's run row; this file only owns the DOM. It re-resolves once
   a second while open, so a crate whose run starts, spends and ends while you watch says so as it happens.

   A small body-child popover, not a window: one at a time, closes on ✕ / ESC / a press anywhere else. Positioned by
   the uiZoom law (clientX is VISUAL px; a body child's style px are body-zoomed px — divide once). */
'use strict';

const CrateCard = (() => {
  let el = null, cur = null, timer = 0, row = null, rowFor = null, lastFetch = 0, fetching = false, keysBound = false;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const zoom = () => ((typeof U !== 'undefined' && U.uiZoom) ? U.uiZoom() : 1);

  function close() {
    if (timer) { clearTimeout(timer); timer = 0; }
    cur = null; row = null; rowFor = null;
    if (el) { el.remove(); el = null; }
  }
  function bindKeys() {
    if (keysBound || typeof document === 'undefined') return;
    keysBound = true;
    document.addEventListener('keydown', e => { if (el && e.key === 'Escape') { e.stopPropagation(); close(); } }, true);
    // a press anywhere outside the card dismisses it (the press that opened it landed before the card existed)
    document.addEventListener('pointerdown', e => { if (el && !el.contains(e.target)) close(); }, true);
  }
  function mount() {
    if (el) return;
    el = document.createElement('aside');
    el.className = 'lw-card';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Crate');
    document.body.appendChild(el);
    el.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || !cur) return;
      const a = b.getAttribute('data-a');
      if (a === 'x') { close(); return; }
      const card = cur.resolve(row);
      if (a === 'run' && card.actions.transcript && cur.openRun) { const t = card.actions.transcript; close(); cur0(t, 'run'); return; }
      if (a === 'wf' && card.actions.workflow && cur.openWorkflow) { const f = card.actions.workflow; close(); cur0(f, 'wf'); }
    });
  }
  // the opener's callbacks outlive close() (which clears `cur`), so they are captured per open
  let doors = null;
  // doors open AFTER this click finishes dispatching: a surface opened mid-click (REFIT) would otherwise receive the
  // same click as its own first input and dismiss itself
  function cur0(arg, which) {
    if (!doors) return;
    const fn = which === 'run' ? doors.openRun : doors.openWorkflow;
    setTimeout(() => { try { fn(arg); } catch (_) { /* a door that fails leaves the floor as it was */ } }, 0);
  }
  function place(cx, cy) {
    if (!el) return;
    const z = zoom(), vw = window.innerWidth, vh = window.innerHeight;
    const r = el.getBoundingClientRect();
    let x = cx + 14, y = cy - r.height / 2;
    if (x + r.width > vw - 8) x = cx - 14 - r.width;
    y = Math.max(8, Math.min(vh - r.height - 8, y));
    x = Math.max(8, x);
    el.style.left = (x / z) + 'px'; el.style.top = (y / z) + 'px';
  }
  function fetchRow() {
    if (!cur || fetching || typeof fetch === 'undefined') return;
    const rid = cur.runIdOf();
    if (!rid || !cur.runEnded()) return;                       // the server writes a run's row when it ENDS
    if (row && row.runId === rid) return;                      // already have it
    if (rowFor === rid && Date.now() - lastFetch < 2000) return;   // re-ask at most every 2 s until the row lands
    fetching = true; lastFetch = Date.now(); rowFor = rid;
    const want = cur;
    const url = (cur.api ? cur.api('/api/runs?agent=*&runId=' + encodeURIComponent(rid)) : '/api/runs?agent=*&runId=' + encodeURIComponent(rid));
    fetch(url, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(j => {
      fetching = false;
      if (cur !== want) return;
      const hit = j && Array.isArray(j.runs) ? j.runs.find(x => x && x.runId === rid) : null;
      if (hit) { row = hit; paint(); }
    }).catch(() => { fetching = false; });
  }
  function paint() {
    if (!el || !cur) return;
    const card = cur.resolve(row);
    // the RUN row shows the agent by its SKIN (AgentPortraits — the body the floor draws), once a run is proven
    const who = card.runBy && typeof cur.agentOf === 'function' ? cur.agentOf(card.runBy) : null;
    const skin = who && typeof AgentPortraits !== 'undefined' && AgentPortraits.thumbHTML ? AgentPortraits.thumbHTML(who, 22, 28, 'lw-thumb') : '';
    const rows = card.rows.map(r => '<div class="lw-row"><dt>' + esc(r[0]) + '</dt><dd' + (skin && r[0] === 'RUN' ? ' class="lw-who">' + skin + '<span>' + esc(r[1]) + '</span>' : '>' + esc(r[1])) + '</dd></div>').join('');
    const doorsHtml = (card.actions.transcript ? '<button type="button" class="bb sm" data-a="run">▸ LOGBOOK · TRANSCRIPT</button>' : '')
      + (card.actions.workflow ? '<button type="button" class="bb sm" data-a="wf">▸ WORKFLOW PANEL</button>' : '');
    el.setAttribute('data-state', card.state);
    el.innerHTML = '<header class="lw-head"><span class="lw-kind">' + esc(card.kind) + '</span><span class="lw-st">' + esc(card.state === 'running' ? 'LIVE' : card.state === 'pending' ? 'QUEUED' : card.state.toUpperCase()) + '</span>'
      + '<button type="button" class="bb xs lw-x" data-a="x" aria-label="Close">✕</button></header>'
      + '<dl class="lw-rows">' + rows + '</dl>'
      + (doorsHtml ? '<footer class="lw-foot">' + doorsHtml + '</footer>' : '');
  }
  function tick() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; if (!cur) return; fetchRow(); paint(); tick(); }, 1000);
  }
  /* open({ clientX, clientY, payload, resolve(row)->card, runIdOf(), runEnded(), openRun(t), openWorkflow(f), api?, agentOf(aid)->{id,skin}? }) */
  function open(o) {
    if (!o || typeof o.resolve !== 'function') return false;
    close();
    bindKeys();
    cur = o; doors = { openRun: o.openRun, openWorkflow: o.openWorkflow };
    mount(); paint(); place(o.clientX || 0, o.clientY || 0);
    fetchRow(); tick();
    return true;
  }
  const isOpen = () => !!el;
  const text = () => (el ? el.innerText : null);
  return { open, close, isOpen, text };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = CrateCard;
