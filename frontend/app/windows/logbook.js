/* STARNET — windows/logbook.js : the LOGBOOK lane of the AGENT DOSSIER (extracted from stationui.js).
   NAV CONDENSE 2 (2026-08-04): the LOGBOOK is agent-scoped, so it lives where the agent lives — a
   section of the dossier instead of a SYSTEM-dock window. This file registers a DossierLane
   ((body)=>({sections,wire})); stationui's buildAgents mounts the section and runs wire() after its
   own console mount. The dossier's roster rail drives agent switching (this lane reads the live
   H.present/H.sel views on every rebuild), so the old rail-top roster switcher is gone. */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.h) return;
  const H = StationUI.h;
  const esc = H.esc, fmtRel = H.fmtRel;

  /* ============== LOGBOOK — the reviewable run-history + SLAG post-mortems (the durable record) ==============
     Two read-only surfaces the audit found were written-but-never-read: RUNS folds the append-only run-history
     logbook (GET /api/runs — every finished run's outcome/reason), and SLAG renders World.slagLog() — the
     unproductive-run post-mortems (cause + fix) that used to live only as a fading toast. (WIRING_AUDIT P7.) */
  const LB_REASON = { done: '✓ done', max_iters: '⟳ looped out', budget: 'over budget', cancelled: '⏹ cancelled', error: '✕ error', refusal: '⊘ refused' };
  function logbookLane(body) {
    const a = H.present[H.sel] || {};   // live core state via the h getters
    const agentId = a.id || 'agent';
    const nm = a.name || agentId;   // the LOGBOOK is agent-scoped — name it, don't imply a station-wide record
    // ONE dossier section, three stacked blocks (RUNS · SLAG · INSIGHTS) under the sub-header
    // vocabulary the SKILL LIBRARY uses. Each block keeps its OWN host (#lb-list / #lb-slag /
    // #lb-insights) so a mid-fetch agent switch can't write into a sibling's list.
    const secLogbook =
      '<div class="sec"><span class="sec-l">RUNS</span><span class="sec-r"></span><span class="sec-nd"></span></div>' +
      '<p class="sk-note">Real work by <b>' + esc(nm) + '</b>, newest first — runs that used tools, produced files, or failed. Chat-only replies are folded at the bottom.</p>' +
      '<div id="lb-list" class="mc-list"><span class="loading pulse">loading…</span></div>' +
      '<div class="sec"><span class="sec-l">RUN ISSUES</span><span class="sec-r"></span><span class="sec-nd"></span></div>' +
      '<p class="sk-note">Review why a run ended without a result and what to try next.</p>' +
      '<div id="lb-slag" class="mc-list"><span class="loading pulse">loading…</span></div>' +
      '<div class="sec"><span class="sec-l">INSIGHTS</span><span class="sec-r"></span><span class="sec-nd"></span></div>' +
      '<div id="lb-insights" class="mc-list"><span class="loading pulse">loading…</span></div>';
    const sections = [
      { id: 'logbook', label: 'LOGBOOK', glyph: '▦', desc: 'Run history for ' + nm + ' — real work, dead-run post-mortems, and outcome insights.',
        build: (el => { el.innerHTML = secLogbook; }) }
    ];
    function wire() {
    const listEl = body.querySelector('#lb-list');
    function runRow(r) {
      const when = r.ts ? esc(fmtRel(new Date(r.ts).toISOString())) : '';
      const rl = LB_REASON[r.reason] || esc(r.reason || 'done');
      const title = r.title ? esc(r.title) : esc(String(r.runId || 'run').slice(0, 12));
      const model = esc(r.model || '(unknown)');
      // H3.2: a run with a streamId can OPEN its transcript inline (the join the audit found was missing).
      const sid = r.streamId ? esc(String(r.streamId)) : '';
      const cls = sid ? 'mc-row lb-run-open' : 'mc-row';
      const attr = sid ? ' data-stream="' + sid + '"' : '';
      // explicit ▸ toggle button for the transcript (keyboard-reachable), plus the whole row stays clickable —
      // but the row handler ignores clicks made while selecting text (so you can copy a title without collapsing).
      const txBtn = sid ? ' <button type="button" class="lb-tx-btn" aria-expanded="false" title="show / hide this run\'s transcript">▸ transcript</button>' : '';
      return '<div class="' + cls + '"' + attr + '><div class="mc-top"><b>' + title + '</b> <span class="dim">' + when + '</span>' + txBtn + '</div>' +
        '<div class="mc-url dim">' + rl + ' · ' + model + ' · ' + (r.turns || 0) + ' turn' + (r.turns === 1 ? '' : 's') + '</div>' +
        (sid ? '<div class="lb-tx" hidden></div>' : '') + '</div>';
    }
    function insightsHtml(j) {
      j = j || {};
      if (!j.totalRuns) return '<div class="fb-empty">NO DATA YET.<br><span>Insights appear once this agent finishes some runs.</span></div>';
      const ov = '<div class="mc-row"><div class="mc-top"><b>' + j.totalRuns + ' run' + (j.totalRuns === 1 ? '' : 's') + '</b></div>' +
        '<div class="mc-url dim">' + (j.successPct == null ? '—' : j.successPct + '% success') + '</div></div>';
      const models = (j.byModel || []).slice(0, 8).map(m =>
        '<div class="mc-row"><div class="mc-top"><b>' + esc(m.model) + '</b> <span class="dim">' + m.runs + ' run' + (m.runs === 1 ? '' : 's') + '</span></div></div>').join('');
      // pretty-label the outcome enum with the same map RUNS uses (LB_REASON) instead of leaking raw keys.
      const reasons = Object.keys(j.byReason || {}).map(k => (LB_REASON[k] || esc(k)) + ' ' + j.byReason[k]).join(' · ');
      return ov + '<div class="mc-detail" style="margin:6px 0 2px;opacity:.7">BY MODEL</div>' + (models || '<div class="mc-detail dim">—</div>') +
        '<div class="mc-detail" style="margin:6px 0 2px;opacity:.7">OUTCOMES</div><div class="mc-detail dim">' + (reasons || '—') + '</div>';
    }
    function noSpendText(s) {
      return String(s || '')
        .replace(/\bspend\b/ig, 'run resources')
        .replace(/\bdollars?\b/ig, 'limits')
        .replace(/billed at full price every turn/ig, 'processed cold every turn')
        .replace(/~10× cheaper input/ig, 'more efficient input');
    }
    function slagRow(d) {
      return '<div class="mc-row"><div class="mc-top"><b style="color:var(--bad)">⚠ ' + esc(noSpendText(d.title || 'unproductive run')) + '</b></div>' +
        '<div class="mc-url dim">' + esc(noSpendText(d.cause || '')) + '</div>' +
        (d.fix ? '<div class="mc-detail">→ ' + esc(noSpendText(d.fix)) + '</div>' : '') + '</div>';
    }
    // RUNS: the append-only run history (GET /api/runs), with each run's transcript lazy-expandable inline.
    // Each loader re-queries its host by id after the await so a panel closed mid-fetch is a safe no-op (mirrors
    // loadMemoryCore), and only ever writes its OWN section host — never a sibling's.
    async function loadRuns() {
      const host = body.querySelector('#lb-list'); if (!host) return;
      try {
        const j = await Harness.api.get('/api/runs?agent=' + encodeURIComponent(agentId) + '&limit=100');
        const h = body.querySelector('#lb-list'); if (!h) return;
        const runs = (j && j.runs) || [];
        // PRACTICAL FOLD: every chat message is a run, so an interactive station's history is mostly talk-only
        // rows that bury the record that matters (away/cron runs, failures, real work). A row is CHATTER when the
        // run ended fine with ZERO successful tool calls and ZERO artifacts — provable from the row's own recorded
        // fields (toolsOk / artifacts), never a guess. Chatter folds behind an honest count; work renders up front.
        const isChat = r => r.reason === 'done' && !(r.toolsOk > 0) && !(r.artifacts && r.artifacts.length);
        const work = runs.filter(r => !isChat(r));
        const chatter = runs.filter(isChat);
        const foldLabel = open => (open ? '▾ ' : '▸ ') + chatter.length + ' CHAT-ONLY ' + (chatter.length === 1 ? 'REPLY' : 'REPLIES') + ' — no tools, no files';
        h.innerHTML = runs.length
          ? (work.length ? work.map(runRow).join('')
              : '<div class="fb-empty">NO TASK RUNS YET.<br><span>Runs that use tools, write files, or fail land here.</span></div>')
            + (chatter.length
              ? '<button type="button" class="bb sm" id="lb-chat-fold" aria-expanded="false" style="margin-top:8px">' + foldLabel(false) + '</button>'
                + '<div id="lb-chat-rows" hidden>' + chatter.map(runRow).join('') + '</div>'
              : '')
          : '<div class="fb-empty">NO RUNS YET.<br><span>Finished runs appear here once this agent does real work.</span></div>';
        const fold = h.querySelector('#lb-chat-fold');
        if (fold) fold.addEventListener('click', () => {
          const rowsEl = h.querySelector('#lb-chat-rows'); if (!rowsEl) return;
          rowsEl.hidden = !rowsEl.hidden;
          fold.setAttribute('aria-expanded', String(!rowsEl.hidden));
          fold.textContent = foldLabel(!rowsEl.hidden);
        });
        // H3.2: a run opens its durable transcript (GET /api/transcript?stream=) inline — toggle + lazy-load.
        const toggleTx = async (row) => {
          const tx = row.querySelector('.lb-tx'); if (!tx) return;
          const btn = row.querySelector('.lb-tx-btn');
          if (!tx.hidden) { tx.hidden = true; row.classList.remove('tx-open'); if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.textContent = '▸ transcript'; } return; }
          tx.hidden = false; row.classList.add('tx-open'); if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.textContent = '▾ transcript'; }
          if (tx.dataset.loaded) return;
          tx.innerHTML = '<div class="mc-detail"><span class="loading">loading transcript…</span></div>';
          try {
            const t = await Harness.api.get('/api/transcript?stream=' + encodeURIComponent(row.dataset.stream) + '&agent=' + encodeURIComponent(agentId) + '&limit=50');
            const turns = (t && t.turns) || [];
            tx.innerHTML = turns.length ? turns.map(m => '<div class="mc-detail"><b>' + esc(m.role) + ':</b> ' + esc(String(m.content || '').slice(0, 400)) + '</div>').join('') : '<div class="mc-detail">no transcript recorded for this workstream.</div>';
            tx.dataset.loaded = '1';
          } catch (_) { tx.innerHTML = '<div class="mc-detail">could not load transcript.</div>'; }
        };
        h.querySelectorAll('.lb-run-open').forEach(row => {
          row.addEventListener('click', ev => {
            if (ev.target.closest('.lb-tx-btn')) return;                 // the button owns its own click (below)
            if (ev.target.closest('.lb-tx')) return;                     // clicks inside an open transcript don't collapse it
            const selTxt = (window.getSelection && window.getSelection().toString()) || '';
            if (selTxt.trim()) return;                                   // dragging to SELECT text must not toggle
            toggleTx(row);
          });
          const btn = row.querySelector('.lb-tx-btn');
          if (btn) btn.addEventListener('click', ev => { ev.stopPropagation(); toggleTx(row); });
        });
      } catch (_) { const h = body.querySelector('#lb-list'); if (h) h.innerHTML = '<div class="mc-detail">sidecar offline — start it to see run history.</div>'; }
    }
    // SLAG: the unproductive-run post-mortems (World.slagLog), synchronous — no fetch, just the live ring.
    function loadSlag() {
      const host = body.querySelector('#lb-slag'); if (!host) return;
      let slag = [];
      try { if (typeof World !== 'undefined' && World.slagLog) slag = World.slagLog().slice().reverse(); } catch (_) {}
      host.innerHTML = slag.length ? slag.map(slagRow).join('') : '<div class="fb-empty">NO RUN ISSUES RECORDED.<br><span>A post-mortem appears here when a run ends without producing a result.</span></div>';
    }
    // INSIGHTS: aggregate outcomes folded from the run history (GET /api/insights). H3.3.
    async function loadInsights() {
      const host = body.querySelector('#lb-insights'); if (!host) return;
      try {
        const j = await Harness.api.get('/api/insights?agent=' + encodeURIComponent(agentId));
        const h = body.querySelector('#lb-insights'); if (h) h.innerHTML = insightsHtml(j);
      } catch (_) { const h = body.querySelector('#lb-insights'); if (h) h.innerHTML = '<div class="mc-detail">sidecar offline — start it to see insights.</div>'; }
    }
    // all three hosts exist up-front in the one section, so load each once — no tab gating.
    loadRuns(); loadSlag(); loadInsights();
    }

    return { sections, wire };
  }

  window.DossierLanes = window.DossierLanes || [];
  window.DossierLanes.push(logbookLane);
})();
