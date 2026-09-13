/* STARNET deliverable library: safe preview helpers + backend-backed Workshop/artifact browser. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Deliverables = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function safeMarkdown(raw) {
    return String(raw || '').slice(0, 512 * 1024).split(/\r?\n/).map(line => {
      let s = esc(line).replace(/\*\*([^*]{1,500})\*\*/g, '<strong>$1</strong>').replace(/`([^`]{1,500})`/g, '<code>$1</code>');
      const h = s.match(/^(#{1,3})\s+(.+)$/); if (h) return '<h' + h[1].length + '>' + h[2] + '</h' + h[1].length + '>';
      return s ? '<p>' + s + '</p>' : '';
    }).join('');
  }
  function csvRows(raw, maxRows, maxCols) {
    const rows = []; let row = [], cell = '', quoted = false;
    raw = String(raw || '').slice(0, 512 * 1024); maxRows = Math.max(1, maxRows || 50); maxCols = Math.max(1, maxCols || 20);
    for (let i = 0; i <= raw.length && rows.length < maxRows; i++) {
      const c = i < raw.length ? raw[i] : '\n';
      if (quoted && c === '"' && raw[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = !quoted;
      else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
        if (row.length < maxCols) row.push(cell); cell = '';
        if (c === '\r' && raw[i + 1] === '\n') i++;
        if (c !== ',') { rows.push(row); row = []; }
      } else cell += c;
    }
    return rows;
  }
  function safeCsv(raw, maxRows, maxCols) {
    const rows = csvRows(raw, maxRows, maxCols);
    return '<table class="deliverable-csv"><tbody>' + rows.map((r, ri) => '<tr>' + r.map(c => '<' + (ri ? 'td' : 'th') + '>' + esc(c) + '</' + (ri ? 'td' : 'th') + '>').join('') + '</tr>').join('') + '</tbody></table>';
  }
  function openUrl(url, token) { return String(url || '') + (String(url || '').indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(String(token || '')); }
  const fmtSize = n => n == null ? 'size unknown' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const token = () => typeof window !== 'undefined' ? String(window.__STARNET_API_TOKEN__ || '') : '';
  const apiBase = () => typeof window !== 'undefined' ? String(window.__STARNET_API__ || '') : '';
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });

  function fileHref(f) {
    const href = openUrl(f && f.openUrl, token());
    const base = apiBase();
    return base && href.charAt(0) === '/' ? base + href : href;
  }
  // The backend's openUrl already carries the exact jailed path it proved. Read that value instead of
  // rebuilding Workshop paths from display fields (a kept/pending row may have a different lifecycle shape).
  function artifactPath(f) {
    const match = String((f && f.openUrl) || '').match(/[?&]path=([^&#]*)/);
    if (match) { try { return decodeURIComponent(match[1]); } catch (_) {} }
    return String((f && f.path) || '');
  }
  function tauriCore() {
    return (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
  }
  function revokePreview(state) {
    if (!state || !state.blobUrl) return;
    try { URL.revokeObjectURL(state.blobUrl); } catch (_) {}
    state.blobUrl = '';
  }
  async function openDesktop(r, f, href, say) {
    const core = tauriCore();
    if (!core || !core.invoke) return false;
    if (f.sandboxed) {
      try { await core.invoke('open_external_url', { url: href }); }
      catch (_) { if (say) say('Could not open that safe preview in your browser.', true); }
      return true;
    }
    try {
      await core.invoke('starnet_open_artifact', { path: artifactPath(f), agentId: r.agentId || 'agent' });
    } catch (err) {
      // Cancel at the host confirmation is an answer. Falling through would bypass the user's refusal.
      if (/declined at the host/i.test(String(err || ''))) return true;
      try { await core.invoke('open_external_url', { url: href }); }
      catch (_) { if (say) say('Could not open that file — use its session or workspace folder to find it on disk.', true); }
    }
    return true;
  }
  async function previewInCard(f, host, state, say) {
    if (!host) return false;
    revokePreview(state);
    if (state && state.previewHost && state.previewHost !== host) state.previewHost.innerHTML = '';
    if (state) state.previewHost = host;
    host.innerHTML = '<p class="muted">Loading safe preview…</p>';
    try {
      const response = await fetch(fileHref(f), { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (f.preview === 'image') {
        const blobUrl = URL.createObjectURL(await response.blob());
        if (state) state.blobUrl = blobUrl;
        host.innerHTML = '<img class="deliverable-image" alt="Preview of ' + esc(f.path) + '">';
        const img = host.querySelector('img');
        const expiry = setTimeout(() => revokePreview(state), 30000);
        img.onload = img.onerror = () => { clearTimeout(expiry); revokePreview(state); };
        img.src = blobUrl;
      } else {
        const text = await response.text();
        host.innerHTML = '<div class="cfg-block"><b>SAFE PREVIEW · ' + esc(f.path) + '</b>' + (f.preview === 'markdown' ? safeMarkdown(text) : safeCsv(text, 50, 20)) + '</div>';
      }
    } catch (e) {
      host.innerHTML = '';
      // A 404 here has ONE ordinary cause: the file was moved or deleted on disk after the library recorded it.
      // KEEP copies rather than moves, so the archive normally survives — but the Commander owns that folder and
      // may clear it. Say the real reason instead of showing them an HTTP code they cannot act on.
      const gone = /\b404\b/.test(String((e && e.message) || ''));
      if (say) say(gone
        ? 'That file is no longer on disk — it was moved or deleted after this deliverable was recorded.'
        : 'Could not preview that file: ' + e.message, true);
    }
    return true;
  }
  async function handleOpenClick(ev, rows, state, say) {
    const link = ev && ev.target && ev.target.closest ? ev.target.closest('a[data-file]') : null;
    if (!link) return false;
    const card = link.closest('[data-i]');
    const r = card && rows && rows[Number(card.dataset.i)];
    const f = r && r.files && r.files[Number(link.dataset.file) || 0];
    if (!r || !f || !f.openUrl) return false;

    const core = tauriCore();
    // A browser-only non-preview is already a real href; let the anchor perform its native navigation.
    if ((!core || !core.invoke) && (!f.preview || f.sandboxed)) return false;
    ev.preventDefault();
    ev.stopPropagation();
    if (core && core.invoke) return openDesktop(r, f, fileHref(f), say);
    return previewInCard(f, card.querySelector('[data-preview]'), state || {}, say);
  }

  /* ============== THE ORGANIZED LIBRARY (2026-08-13) ==============
     Every card is TWO LAYERS and they are never allowed to blur:
       · the SAY band  — the agent's own title + one-line description (deliverable_note). Prose. No authority.
       · the FACTS band — status, crew, file count, size, time. All derived by the harness from the run log.
     The pill outranks the prose: if a card says "churn analysis" and the run failed, FAILED is what reads loudest.
     A row the agent never named shows its filename as the plain fact it is (`authored:false`) rather than dressing
     a basename up as a description — a title we invented would be the same lie in a nicer font. */

  const DAY_MS = 86400000;
  // Time buckets, the axis people actually search on when they can't remember the project. Injected `now` so this
  // is testable headlessly and never reads an ambient clock mid-render.
  function bucketOf(ts, now) {
    if (!ts) return 'EARLIER';
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    if (ts >= midnight.getTime()) return 'TODAY';
    if (ts >= midnight.getTime() - 6 * DAY_MS) return 'THIS WEEK';
    return 'EARLIER';
  }
  const BUCKETS = ['TODAY', 'THIS WEEK', 'EARLIER'];

  // "2h ago" for the glance; the exact stamp still shows in the details drawer. Same vocabulary the sessions and
  // projects rails already use, so the three surfaces read as one system.
  function agoOf(ts, now) {
    if (!ts) return '';
    const d = Math.max(0, now - ts);
    if (d < 60000) return 'just now';
    const m = Math.floor(d / 60000); if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    const days = Math.floor(h / 24); if (days < 30) return days + 'd ago';
    return Math.floor(days / 30) + 'mo ago';
  }

  // status -> the pill a person can read. `pending` is the only one that asks for something, so it alone is gold.
  const PILLS = {
    kept: { label: 'KEPT', cls: 'ok' },
    produced: { label: 'DONE', cls: 'ok' },
    // a PLAN the Commander pressed Implement on: it was acted on and produced a build. Distinct from KEPT on
    // purpose — nothing was copied to a folder, so calling it kept would assert a file landing that never happened.
    implemented: { label: 'IMPLEMENTED', cls: 'ok' },
    pending: { label: 'NEEDS A DECISION', cls: 'warn' },
    failed: { label: 'FAILED', cls: 'bad' },
    discarded: { label: 'DISCARDED', cls: 'off' }
  };
  function pillOf(status) {
    return Object.prototype.hasOwnProperty.call(PILLS, status) ? PILLS[status] : { label: String(status || 'UNKNOWN').toUpperCase(), cls: 'off' };
  }
  // A raw agentId reads as debug output; resolve through the live roster the same way every other window does.
  function agentLabel(id) {
    if (typeof App !== 'undefined' && App && typeof App.agentName === 'function') { try { return App.agentName(id) || id; } catch (_) {} }
    return String(id || 'agent');
  }

  function rowsForRun(items, runId, query) {
    const needle = String(query || '').trim().toLowerCase();
    return items.filter(r => r.runId === runId && (!needle || [r.title, r.summary, r.ask].join(' ').toLowerCase().includes(needle)));
  }
  function mount(body) {
    let rows = [], projects = [], kinds = [], summary = null, loadSeq = 0, project = '', kind = '';
    let runFilter = null;
    const openState = { blobUrl: '', previewHost: null };
    const revoke = () => revokePreview(openState);
    body.innerHTML = '<div class="cfg dlv"><h3>DELIVERABLES / WORKSHOP LIBRARY</h3><p class="muted">Everything your agents actually made, filed under the project it was made for. Open any one to see what you asked for, what came back, and every file it produced. Previews open safely inside StarNet in a browser; desktop OPEN uses your file app.</p>' +
      '<div id="dl-head" class="dlv-head-strip"></div><div id="dl-run-scope" class="cfg-block" hidden></div>' +
      '<div class="deliverables-toolbar"><input id="dl-query" aria-label="Search deliverables" placeholder="search title, agent, project"><select id="dl-status" aria-label="Filter deliverables"><option value="">ALL STATUS</option><option>pending</option><option>kept</option><option>implemented</option><option>discarded</option><option>produced</option><option>failed</option></select><button class="bb sm" id="dl-refresh">REFRESH</button><button class="bb sm" id="dl-clean">CLEAN OLD RECORDS</button></div>' +
      '<div id="dl-kinds" class="dlv-kinds"></div>' +
      '<div id="dl-msg" class="msg" aria-live="polite"></div><div id="dl-cleanup"></div>' +
      '<div class="dlv-split"><nav id="dl-rail" class="dlv-rail" aria-label="Projects"></nav><div id="dl-list" class="dlv-main"></div></div></div>';
    const q = body.querySelector('#dl-query'), status = body.querySelector('#dl-status'), list = body.querySelector('#dl-list'), rail = body.querySelector('#dl-rail'), msg = body.querySelector('#dl-msg'), cleanup = body.querySelector('#dl-cleanup'), head = body.querySelector('#dl-head'), kindbar = body.querySelector('#dl-kinds');
    const say = (s, bad) => { msg.textContent = s || ''; msg.className = 'msg ' + (bad ? 'bad' : 'ok'); };
    const runScope = body.querySelector('#dl-run-scope');
    const renderRunScope = () => {
      runScope.hidden = !runFilter;
      runScope.innerHTML = runFilter ? '<b>OUTPUTS FROM THIS STEP</b><p>' + esc(runFilter.label) + '</p><button class="bb sm" id="dl-all-runs">SHOW ALL WORK</button>' : '';
      runScope.querySelector('button')?.addEventListener('click', () => { runFilter = null; q.value = ''; status.value = ''; project = ''; kind = ''; renderRunScope(); load(); });
    };
    body._deliverablesShowRun = (runId, label) => {
      runFilter = { runId: String(runId), label: String(label || 'Selected step') };
      q.value = ''; status.value = ''; project = ''; kind = ''; renderRunScope(); load();
    };

    /* THE PROJECT RAIL. Counts come from the server's facet, which is computed BEFORE the project filter runs —
       so selecting one project can never hide the others. A root whose path grant was revoked still appears,
       marked: it names work that really happened, and hiding it would be the library lying by omission. */
    function renderRail() {
      const total = projects.reduce((n, p) => n + (Number(p.count) || 0), 0);
      const row = (key, name, count, extra) =>
        '<button class="dlv-proj' + (project === key ? ' on' : '') + '" data-project="' + esc(key) + '">' +
        '<span class="dlv-proj-n">' + esc(name) + '</span><span class="dlv-proj-c">' + count + '</span>' + (extra || '') + '</button>';
      rail.innerHTML = row('', 'ALL WORK', total) + projects.map(p =>
        row(p.unfiled ? 'unfiled' : p.root, p.name, p.count, p.blessed ? '' : '<span class="dlv-proj-rev">folder access revoked</span>')
      ).join('');
    }

    function crewHtml(r) {
      const crew = Array.isArray(r.contributors) ? r.contributors : [];
      if (!crew.length) return '';
      // The LEAD carries the phosphor rail, workers are dim chips — the same "position identifies the speaker"
      // idea COMMS uses, so a two-agent card reads as a hierarchy without anyone having to parse a legend.
      // `identityFallback` is surfaced, never swallowed: that run was NOT the named specialist.
      return '<span class="dlv-crew">' + crew.map(c =>
        '<span class="dlv-who' + (c.role === 'lead' ? ' lead' : '') + '">' + esc(agentLabel(c.agentId)) +
        (c.identityFallback ? '<i> stand-in</i>' : '') + '</span>').join('') + '</span>';
    }

    /* ONE CARD = a glance + a drawer, following the shape Andrew locked for the OUTBOX window: the collapsed row
       carries the identity and the verdict and NO buttons, and everything that needs reading or deciding lives
       one click down. One drawer open at a time. The glance answers "what is this and is it done"; the drawer
       answers "what exactly did I get, what did it cost, and where is it". */
    /* THE DRAWER — three things, and nothing else: what was asked, what came back, and what you can open.
       An earlier draft also listed model, cost, duration, turns and tool counts. Andrew cut every one of them:
       run metrics are the LOGBOOK's subject, and putting them on the card that answers "what did I get" only
       made that answer harder to find. Anything added back here must be ABOUT THE OUTPUT, not the machinery. */
    function detailHtml(r) {
      const run = r.run || null;
      const files = r.files || [];
      const sec = (label, inner) => inner ? '<div class="dlv-sec"><h5>' + label + '</h5>' + inner + '</div>' : '';
      // THE ASK — the Commander's own words, quoted rather than paraphrased.
      const ask = sec('WHAT YOU ASKED FOR', r.ask ? '<p class="dlv-quote">' + esc(r.ask) + '</p>' : '');
      // WHAT CAME BACK — the agent's recorded closing message, and ONLY when the run kept one. It deliberately
      // does NOT fall back to the deliverable's summary: that sentence is already on the row directly above, and
      // reprinting it here would put the same words on screen twice, forty pixels apart. A section that repeats
      // what you just read is the added complexity this pass exists to remove.
      const back = sec('WHAT CAME BACK', (run && run.deliveryText) ? '<div class="dlv-said">' + esc(run.deliveryText) + '</div>' : '');
      // THE FILES — each openable on its own, with the size measured off disk.
      const fileRows = files.length
        ? '<ul class="dlv-files">' + (r.files || []).map((f, fi) => f.openUrl
            ? '<li><a class="bb sm' + (r.main && f.path === r.main ? ' dlv-hero' : '') + '" data-file="' + fi + '" href="' + esc(fileHref(f)) + '" target="_blank" rel="noopener">OPEN</a><span class="dlv-fname">' + esc(f.path) + '</span><span class="dlv-fsize">' + esc(fmtSize(f.bytes)) + '</span>' + (r.main && f.path === r.main ? '<span class="dlv-fmain">the main one</span>' : '') + '</li>'
            : '<li><span class="dlv-fname off">' + esc(f.path) + '</span><span class="dlv-fsize">no longer available</span></li>').join('') + '</ul>'
        : '<p class="dlv-none">This run recorded no files.</p>';
      const openSession = (run && run.streamId) ? '<button class="bb sm" data-act="session">↗ OPEN THE FULL CONVERSATION</button>' : '';
      const decide = ((r.actions && r.actions.keep) ? '<button class="bb sm" data-act="keep">KEEP IT</button>' : '') +
        ((r.actions && r.actions.discard) ? '<button class="bb sm danger" data-act="discard">DISCARD</button>' : '');
      const acts = (openSession || decide) ? '<div class="row dlv-acts">' + openSession + decide + '</div>' : '';
      return ask + back + sec('FILES', fileRows) + acts;
    }

    function cardHtml(r, i, now) {
      const pill = pillOf(r.status);
      const nFiles = (r.files || []).length;
      // THE SAY BAND — the agent's words, or an honest admission that there aren't any.
      const say2 = r.authored
        ? '<b class="dlv-title">' + esc(r.title || 'Untitled output') + '</b>' + (r.summary ? '<p class="dlv-sum">' + esc(r.summary) + '</p>' : '')
        : '<b class="dlv-title plain">' + esc(r.title || 'Untitled output') + '</b>' + (r.summary ? '<p class="dlv-sum">' + esc(r.summary) + '</p>' : '<p class="dlv-sum none">the agent did not name this one</p>');
      // THE FACTS BAND — every item here is provable from the run log.
      // "size unknown" is for a file we could not measure. A row with NO files has nothing to measure, so it says
      // so — the two are different facts and the wrong one reads as a failed read.
      const bulk = nFiles ? (nFiles + (nFiles === 1 ? ' file · ' : ' files · ') + fmtSize(r.size)) : 'no files';
      const facts = '<span class="dlv-pill ' + pill.cls + '">' + esc(pill.label) + '</span>' + crewHtml(r) +
        '<span class="dlv-meta">' + esc(bulk) + (r.createdAt ? ' · ' + esc(agoOf(r.createdAt, now)) : '') + '</span>';
      return '<article class="dlv-card" data-i="' + i + '">' +
        '<button class="dlv-head" type="button" aria-expanded="false" aria-controls="dlv-more-' + i + '">' +
        '<span class="dlv-caret" aria-hidden="true">▸</span><span class="dlv-headmain"><span class="dlv-say">' + say2 + '</span>' +
        '<span class="dlv-facts">' + facts + '</span></span></button>' +
        '<div class="dlv-more" id="dlv-more-' + i + '" hidden>' + detailHtml(r) + '</div>' +
        '<div class="deliverable-preview" data-preview aria-live="polite"></div></article>';
    }

    /* The one-line answer to "what have I been working on", above everything else. Counts come from the server's
       pre-filter summary, so this describes the whole library even while a filter is narrowing the list below —
       and "needs a decision" is a real, clickable route to the only rows that are actually waiting on the user. */
    function renderSummary() {
      if (!summary) { head.innerHTML = ''; return; }
      const bits = [];
      bits.push('<b>' + summary.total + '</b> ' + (summary.total === 1 ? 'output' : 'outputs'));
      const nProjects = projects.filter(p => !p.unfiled).length;
      if (nProjects) bits.push('across <b>' + nProjects + '</b> ' + (nProjects === 1 ? 'project' : 'projects'));
      if (summary.newestAt) bits.push('newest <b>' + esc(agoOf(summary.newestAt, Date.now())) + '</b>');
      const pend = summary.pending
        ? '<button class="dlv-needs" data-status="pending">' + summary.pending + ' need' + (summary.pending === 1 ? 's' : '') + ' a decision</button>' : '';
      head.innerHTML = '<div class="dlv-sumline">' + bits.join(' · ') + '</div>' + pend;
    }

    // KIND chips — the second axis, after project. Counts are pre-filter for the same reason the rail's are.
    function renderKinds() {
      if (!kinds.length) { kindbar.innerHTML = ''; return; }
      const chip = (k, label, count) => '<button class="dlv-chip' + (kind === k ? ' on' : '') + '" data-kind="' + esc(k) + '">' + esc(label) + '<span>' + count + '</span></button>';
      kindbar.innerHTML = chip('', 'ALL KINDS', kinds.reduce((n, k) => n + k.count, 0)) + kinds.map(k => chip(k.kind, k.kind, k.count)).join('');
    }

    function render() {
      renderRail();
      renderSummary();
      renderKinds();
      if (!rows.length) {
        // Say what MAKES a deliverable rather than just reporting absence — an empty library is the one moment
        // the window has to teach what it is for.
        // A filtered miss and an empty library are different facts and must not share a headline — "NOTHING HERE
        // YET" over a library that has 40 rows behind a filter is simply false.
        const filtered = !!(runFilter || project || kind || q.value || status.value);
        list.innerHTML = '<div class="dlv-empty">' + (filtered ? 'NO MATCHES.' : 'NOTHING HERE YET.') + '<br><span>' +
          (runFilter ? 'No recorded outputs from this step match this view. A completed run may have no files; use SHOW ALL WORK to return to the library.' : filtered ? 'Nothing in the library fits this view. Clear the filters to see everything.' : 'When a run creates or changes files, it lands here with the agent’s own name for it, the crew that worked on it, and the project it was for.') +
          '</span></div>';
        return;
      }
      const now = Date.now();
      const groups = {};
      rows.forEach((r, i) => { const b = bucketOf(Number(r.createdAt) || 0, now); (groups[b] = groups[b] || []).push(cardHtml(r, i, now)); });
      list.innerHTML = BUCKETS.filter(b => groups[b] && groups[b].length)
        .map(b => '<section class="dlv-bucket"><h4>' + b + '</h4>' + groups[b].join('') + '</section>').join('');
      wireDiscards();
    }
    // Re-wired after every render: innerHTML replaces the buttons, so the previous listeners die with the
    // old nodes and there is nothing to dispose. If armconfirm.js somehow did not load, the buttons stay
    // unwired and the delegated handler discards on a single click — we do NOT fork a fourth hand-rolled
    // copy of the arm/confirm idiom here, which is the thing that helper was extracted to prevent.
    function wireDiscards() {
      if (typeof ArmConfirm === 'undefined' || !ArmConfirm.wire) return;
      list.querySelectorAll('button[data-act="discard"]').forEach(b => {
        // ONCE per node: toggleCard() re-calls this without a re-render, and ArmConfirm.wire ADDS a fresh
        // click listener with its own private `armed` flag each time — double-wired, one confirm click ran
        // onConfirm TWICE (two irreversible workshop deletes; N open drawers = N+1). The wired stamp was
        // written but never read; it is the guard now.
        if (b.dataset.wired === '1') return;
        const r = rows[Number(b.closest('[data-i]').dataset.i)];
        if (!r) return;
        b.dataset.wired = '1';
        ArmConfirm.wire(b, {
          armedLabel: 'DISCARD — SURE?',
          onArm: () => say('Discarding “' + (r.title || 'this output') + '” also removes its Workshop files permanently. Click again to confirm.', true),
          onDisarm: () => say(''),   // disarming just clears the warning; it is not an excuse to restate the count
          onConfirm: () => decide(r, 'discard', b)
        });
      });
    }
    async function load() {
      const seq = ++loadSeq; say('Loading…');
      const url = '/api/deliverables?query=' + encodeURIComponent(runFilter ? runFilter.runId : q.value) + '&status=' + encodeURIComponent(status.value) + '&project=' + encodeURIComponent(project) + '&kind=' + encodeURIComponent(kind);
      try {
        const j = await fetch(url, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
        if (seq !== loadSeq) return;
        rows = j.items || [];
        // The backend's text search narrows the request; equality supplies the actual provenance boundary.
        if (runFilter) rows = rowsForRun(rows, runFilter.runId, q.value);
        projects = Array.isArray(j.projects) ? j.projects : [];   // an older sidecar simply sends none -> rail shows ALL WORK only
        kinds = Array.isArray(j.kinds) ? j.kinds : [];
        summary = j.summary || null;
        render();
        // The summary strip above already states the count. This line is for TRANSIENT status only — loading,
        // errors, and the result of an action — so a second standing count does not sit under it saying the
        // same number in different words.
        say('');
      }
      catch (e) { say('Could not load the library: ' + e.message, true); }
    }
    // DISCARD is irreversible (it deletes the Workshop files), so it asks — but with the station's own
    // 2-step arm/confirm, never `window.confirm`. A native dialog is OS chrome painted over the phosphor
    // terminal, which is exactly what armconfirm.js exists to stop ("no native dialogs inside the phosphor
    // terminal"). The permanence sentence the dialog used to carry moves into the live message line on arm,
    // so nothing is claimed less loudly than before — it is just said in the station's voice.
    async function decide(r, act, b) {
      if (b.disabled) return;   // belt to the once-wiring: a second confirm on an in-flight decide is never a second POST
      b.disabled = true;
      try { const j = await post('/api/workshop/decide', { agentId: r.agentId, runId: r.runId, decision: act }); say(j.decision === 'keep' ? ('Kept ' + r.title + (j.destPath ? ' in ' + j.destPath : '')) : ('Discarded ' + r.title)); await load(); }
      catch (e) { b.disabled = false; say(e.message, true); }
    }
    /* ONE DRAWER OPEN AT A TIME — the same rule the OUTBOX accordion follows. Two open drawers turn a scannable
       list back into the wall of text this window exists to replace. Toggling closed also clears any preview the
       drawer painted, so a collapsed card never leaves a stray file rendered under it. */
    function toggleCard(headBtn) {
      const card = headBtn.closest('[data-i]');
      const more = card && card.querySelector('.dlv-more');
      if (!more) return;
      const wasOpen = !more.hidden;
      list.querySelectorAll('.dlv-more').forEach(d => { d.hidden = true; });
      list.querySelectorAll('.dlv-head').forEach(h => { h.setAttribute('aria-expanded', 'false'); h.classList.remove('on'); });
      list.querySelectorAll('[data-preview]').forEach(p => { p.innerHTML = ''; });
      revoke();
      if (!wasOpen) {
        more.hidden = false;
        headBtn.setAttribute('aria-expanded', 'true');
        headBtn.classList.add('on');
        wireDiscards();   // the drawer's DISCARD only exists once it is open
      }
    }

    list.addEventListener('click', async ev => {
      const fileLink = ev.target.closest('a[data-file]');
      if (fileLink) return handleOpenClick(ev, rows, openState, say);
      const headBtn = ev.target.closest('.dlv-head');
      if (headBtn) return toggleCard(headBtn);
      const b = ev.target.closest('button[data-act]'); if (!b) return; const card = b.closest('[data-i]'), r = rows[Number(card.dataset.i)]; if (!r) return;
      // "open the session this came from" — the run's real workstream, via the same seam the OUTBOX uses.
      if (b.dataset.act === 'session') {
        const sid = r.run && r.run.streamId;
        if (!sid) return say('That run did not record a session to open.', true);
        if (typeof App !== 'undefined' && App && typeof App.openWorkstream === 'function') {
          try { App.openWorkstream(sid); if (typeof StationUI !== 'undefined') StationUI.h.workConversation('deliverables'); return; } catch (_) {}
        }
        return say('Could not open that session from here.', true);
      }
      if (b.dataset.act === 'discard' && b.dataset.wired === '1') return;   // its own ArmConfirm listener owns it
      decide(r, b.dataset.act, b);
    });
    rail.addEventListener('click', ev => {
      const b = ev.target.closest('button[data-project]'); if (!b) return;
      project = b.dataset.project || '';
      renderRail();   // paint the selection immediately; the list follows when the fetch lands
      load();
    });
    kindbar.addEventListener('click', ev => {
      const b = ev.target.closest('button[data-kind]'); if (!b) return;
      kind = b.dataset.kind || '';
      renderKinds();
      load();
    });
    // the summary's "N need a decision" is a route, not a label — it drives the real status filter
    head.addEventListener('click', ev => {
      const b = ev.target.closest('button[data-status]'); if (!b) return;
      status.value = b.dataset.status || '';
      load();
    });
    let debounce = 0; q.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(load, 180); }); status.addEventListener('change', load); body.querySelector('#dl-refresh').addEventListener('click', load);
    body.querySelector('#dl-clean').addEventListener('click', async () => {
      try { const p = await post('/api/deliverables/cleanup-preview', { statuses: ['discarded', 'failed'] }); cleanup.innerHTML = '<div class="cfg-block"><b>CLEANUP PREVIEW</b><p>' + p.targets.length + ' discarded/failed lifecycle record(s) will be removed. ' + p.protected.length + ' pending, kept, or produced record(s) are protected. Files are not deleted.</p><ul>' + p.targets.map(r => '<li>' + esc(r.title) + ' · ' + esc(r.status) + ' · ' + esc(r.runId || r.id) + '</li>').join('') + '</ul><button class="bb sm danger" id="dl-clean-apply" ' + (p.targets.length ? '' : 'disabled') + '>REMOVE EXACTLY THESE ' + p.targets.length + ' RECORDS</button></div>'; const apply = cleanup.querySelector('#dl-clean-apply'); if (apply) apply.addEventListener('click', async () => { try { const c = await post('/api/deliverables/cleanup', { statuses: p.statuses, fingerprint: p.fingerprint }); cleanup.innerHTML = '<div class="msg ok">Removed ' + c.removed + ' record(s). <button class="bb sm" id="dl-undo">UNDO</button></div>'; cleanup.querySelector('#dl-undo').addEventListener('click', async () => { const u = await post('/api/deliverables/cleanup-undo', { undoToken: c.undoToken }); say('Restored ' + u.restored + ' record(s).'); cleanup.innerHTML = ''; await load(); }); await load(); } catch (e) { say(e.message, true); } }); }
      catch (e) { say('Could not preview cleanup: ' + e.message, true); }
    });
    body._deliverablesCleanup = revoke;
    load();
  }
  function showRun(body, runId, label) {
    if (!runId || !body || typeof body._deliverablesShowRun !== 'function') return false;
    body._deliverablesShowRun(runId, label); return true;
  }
  return { esc, safeMarkdown, safeCsv, openUrl, fileHref, artifactPath, handleOpenClick, bucketOf, pillOf, agentLabel, agoOf, fmtSize, mount, showRun, rowsForRun, BUCKETS };
});
